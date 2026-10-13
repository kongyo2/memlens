import { promises as fs } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

import { type IndexHealth, MEMORY_CONSTANTS } from "@shared/schema/memory.ts";
import { formatLinkTarget } from "@shared/util/indexEntry.ts";

import { mapConcurrent } from "./concurrency.ts";

/**
 * MEMORY.md (index) の手入れ状況の解析と、 index 内リンクの書き換え。
 *
 * 公式の index ルール:
 *   - memdir.ts buildMemoryLines: "each entry should be one line, under ~150
 *     characters: `- [Title](file.md) — one-line hook`. It has no frontmatter."
 *   - autoDream consolidationPrompt (Phase 4 — Prune and index): "Remove pointers
 *     to memories that are now stale, wrong, or superseded", "if an index line is
 *     over ~200 chars ... shorten the line, move the detail", "Add pointers to
 *     newly important memories"
 *
 * 解析は表示用の補助なので、 index のどの行が問題かを人が辿れることを優先する
 * (行番号は raw ファイル上の 1 始まり)。 frontmatter・HTML コメント・fenced code
 * block の中はエントリとして扱わない。
 */

const { ENTRYPOINT_NAME, INDEX_ENTRY_MAX_CHARS } = MEMORY_CONSTANTS;

/** 公式 FRONTMATTER_REGEX (src/utils/frontmatterParser.ts:123)。 */
const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)---\s*\n?/;

/**
 * インラインリンク / 画像の target (group 1)。 `[text](target "title")` と
 * `[text](<target with spaces>)` を拾う。 text はバックスラッシュエスケープ
 * (`\]` — buildIndexEntry が書く形) と 1 段のネスト括弧、 target は 1 段の
 * 対になった丸括弧 (`file(1).md`) まで許容する。 `d` flag で target の位置を取り、
 * 書き換え時に title 等を壊さない。
 */
const INLINE_LINK_RE =
  /\[(?:\\.|[^[\]\\\n]|\[(?:\\.|[^[\]\\\n])*\])*\]\(\s*(<[^>\n]*>|(?:[^\s()]|\([^\s()]*\))+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/dg;

/**
 * 参照リンクの定義行 `[label]: target` (group 1 が target)。 脚注の定義
 * (`[^1]: 本文`) はリンクではないので除く。
 */
const REFERENCE_DEF_RE = /^[ ]{0,3}\[(?!\^)[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)/d;

/** fenced code block の開始行 (CommonMark: 3 個以上の ` か ~、 その後ろは info string)。 */
const FENCE_OPEN_RE = /^[ ]{0,3}(`{3,}|~{3,})(.*)$/;
/** 閉じフェンス: 開始と同じ文字で同じ長さ以上、 後ろは空白だけ。 */
const FENCE_CLOSE_RE = /^[ ]{0,3}(`{3,}|~{3,})[ \t]*$/;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const PREVIEW_CHARS = 120;

type LinkSpan = {
  /** 行内でのリンク target の位置 (元の行テキスト上)。 */
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  /** index のディレクトリから見た相対パス (`/` 区切り, デコード済み)。 */
  readonly target: string;
};

type EntryLine = {
  /** `split(/(?<=\n)/)` した segment の添字 (= 0 始まり行番号)。 */
  readonly index: number;
  /** コメントを除いた可視テキスト (行末空白除去)。 */
  readonly entry: string;
  /** その行のリンク。 */
  readonly links: readonly LinkSpan[];
  /**
   * links の位置が元の行 (segment) 上の位置と一致し、 行ごと書き換え / 削除して
   * よいか。 行内に HTML コメントがある (複数行コメントの始端 / 終端を含む) 行や
   * BOM 付きの先頭行は false。
   */
  readonly rewritable: boolean;
};

/**
 * リンク target をローカルの相対パスに正規化する。 URL (scheme 付き)、 ページ内
 * アンカー、 絶対パスや `~` 始まりは memory へのポインタではないので null。
 */
export function normalizeLinkTarget(rawTarget: string): string | null {
  let target = rawTarget.trim();
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1).trim();
  if (target.length === 0 || target.startsWith("#")) return null;
  if (SCHEME_RE.test(target)) return null;
  if (target.startsWith("/") || target.startsWith("\\") || target.startsWith("~")) return null;
  target = target.replace(/[?#].*$/, "");
  try {
    target = decodeURIComponent(target);
  } catch {
    /* 不正な %-エンコードはそのまま使う */
  }
  target = normalize(target.replace(/\\/g, "/").trim()).split(sep).join("/");
  return target.length === 0 || target === "." ? null : target;
}

type Fence = { readonly char: string; readonly length: number };

function openingFence(line: string): Fence | null {
  const match = FENCE_OPEN_RE.exec(line);
  const marker = match?.[1];
  if (marker === undefined) return null;
  // バッククォートのフェンスは info string にバッククォートを含められない
  // (含むならコードスパン)。
  if (marker.startsWith("`") && (match?.[2] ?? "").includes("`")) return null;
  return { char: marker.charAt(0), length: marker.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const marker = FENCE_CLOSE_RE.exec(line)?.[1];
  return marker !== undefined && marker.startsWith(fence.char) && marker.length >= fence.length;
}

/**
 * インラインのコードスパン (`` `...` ``) を同じ長さの空白で塗りつぶす。 コードの中に
 * 書かれたリンク記法 (例として書いた `[t](old.md)` 等) をポインタと取り違えない
 * ため。 長さを保つので、 残ったリンクの位置は元の行の位置のまま使える。
 */
function maskCodeSpans(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const ch = line.charAt(i);
    if (ch === "\\" && line.charAt(i + 1) === "`") {
      out += "\\`";
      i += 2;
      continue;
    }
    if (ch !== "`") {
      out += ch;
      i++;
      continue;
    }
    let runEnd = i;
    while (line.charAt(runEnd) === "`") runEnd++;
    const run = runEnd - i;
    // 同じ長さのバッククォート列で閉じる (長さの違う列は中身の一部)。
    let close = -1;
    let k = runEnd;
    while (k < line.length) {
      if (line.charAt(k) !== "`") {
        k++;
        continue;
      }
      let end = k;
      while (line.charAt(end) === "`") end++;
      if (end - k === run) {
        close = k;
        break;
      }
      k = end;
    }
    if (close < 0) {
      // 閉じない列はただの文字。
      out += line.slice(i, runEnd);
      i = runEnd;
      continue;
    }
    out += " ".repeat(close + run - i);
    i = close + run;
  }
  return out;
}

/** 行から HTML コメントを除いた可視部分を返す (複数行コメントは state で追う)。 */
function stripCommentSpans(line: string, inComment: boolean): { text: string; inComment: boolean } {
  let rest = line;
  let text = "";
  let open = inComment;
  while (rest.length > 0) {
    if (open) {
      const end = rest.indexOf("-->");
      if (end < 0) return { text, inComment: true };
      rest = rest.slice(end + 3);
      open = false;
      continue;
    }
    const start = rest.indexOf("<!--");
    if (start < 0) {
      text += rest;
      break;
    }
    text += rest.slice(0, start);
    rest = rest.slice(start + 4);
    open = true;
  }
  return { text, inComment: open };
}

function linkSpans(rawLine: string): LinkSpan[] {
  const spans: LinkSpan[] = [];
  const line = maskCodeSpans(rawLine);
  const def = REFERENCE_DEF_RE.exec(line);
  const defIdx = def?.indices?.[1];
  if (def?.[1] !== undefined && defIdx !== undefined) {
    const target = normalizeLinkTarget(def[1]);
    if (target !== null) spans.push({ start: defIdx[0], end: defIdx[1], raw: def[1], target });
  }
  for (const match of line.matchAll(INLINE_LINK_RE)) {
    const idx = match.indices?.[1];
    if (match[1] === undefined || idx === undefined) continue;
    const target = normalizeLinkTarget(match[1]);
    if (target !== null) spans.push({ start: idx[0], end: idx[1], raw: match[1], target });
  }
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * index の各行のうち「エントリとして読める行」を列挙する (I/O なし)。
 * segments は `split(/(?<=\n)/)` 済みの行 (改行付き)。
 */
function walkEntries(segments: readonly string[]): {
  hasFrontmatter: boolean;
  entries: EntryLine[];
} {
  const text = segments.join("");
  const bomless = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const fm = FRONTMATTER_REGEX.exec(bomless);
  const skipLines = fm ? (fm[0].match(/\n/g) ?? []).length : 0;
  const entries: EntryLine[] = [];
  let inComment = false;
  let fence: Fence | null = null;

  for (let i = skipLines; i < segments.length; i++) {
    let line = (segments[i] ?? "").replace(/\r?\n$/, "");
    if (i === 0 && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const opened = inComment ? null : openingFence(line);
    if (opened !== null) {
      fence = opened;
      continue;
    }
    const hadComment = inComment || line.includes("<!--");
    const visible = stripCommentSpans(line, inComment);
    inComment = visible.inComment;
    const entry = visible.text.trimEnd();
    if (entry.trim().length === 0) continue;
    // BOM を落とした行で位置を取ると segment 上の位置がずれるので、 書き換え用の
    // 位置は BOM 付きの先頭行では使わない (index 先頭行がリンクのことはまず無い)。
    const usable = !hadComment && !(i === 0 && (segments[0] ?? "").charCodeAt(0) === 0xfeff);
    entries.push({
      index: i,
      entry,
      links: usable ? linkSpans(line) : linkSpans(entry),
      rewritable: usable,
    });
  }
  return { hasFrontmatter: fm !== null, entries };
}

function splitSegments(raw: string): string[] {
  return raw.split(/(?<=\n)/);
}

function preview(text: string): string {
  const chars = [...text];
  return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join("")}…` : text;
}

export type IndexTextScan = {
  readonly hasFrontmatter: boolean;
  readonly longEntries: IndexHealth["longEntries"];
  readonly links: ReadonlyArray<{ readonly line: number; readonly target: string }>;
};

/** MEMORY.md の raw テキストを走査する (I/O なし)。 */
export function scanIndexText(raw: string): IndexTextScan {
  const { hasFrontmatter, entries } = walkEntries(splitSegments(raw));
  const longEntries: Array<IndexHealth["longEntries"][number]> = [];
  const links: Array<{ line: number; target: string }> = [];
  for (const { index, entry, links: spans } of entries) {
    const length = [...entry].length;
    if (length > INDEX_ENTRY_MAX_CHARS) {
      longEntries.push({ line: index + 1, length, preview: preview(entry.trim()) });
    }
    for (const span of spans) links.push({ line: index + 1, target: span.target });
  }
  return { hasFrontmatter, longEntries, links };
}

/** case-insensitive な既定 fs (Windows / macOS) ではパス比較を小文字で行う。 */
export function comparablePath(relPath: string): string {
  const unified = relPath.replace(/\\/g, "/");
  return process.platform === "win32" || process.platform === "darwin"
    ? unified.toLowerCase()
    : unified;
}

/** baseDir 内に収まる相対パスを `/` 区切りで返す (外に出る / baseDir 自身なら null)。 */
export function relativeInside(baseDir: string, absPath: string): string | null {
  const rel = relative(baseDir, absPath);
  // 別ドライブ (Windows) だと relative は絶対パスを返す。
  if (rel.length === 0 || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null;
  }
  return rel.split(sep).join("/");
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * index (memoryDir/MEMORY.md) の手入れ状況を計算する。 raw が null なら index は
 * 未作成で、 すべての top-level memory が「index に無い」扱いになる。
 */
export async function analyzeIndex(memoryDir: string, raw: string | null): Promise<IndexHealth> {
  const dir = memoryDir.replace(/[/\\]+$/, "");
  const scan = raw === null ? null : scanIndexText(raw);

  const resolved = await mapConcurrent(scan?.links ?? [], 16, async (link) => {
    const rel = relativeInside(dir, join(dir, link.target));
    if (rel === null) return null;
    return { line: link.line, rel, exists: await exists(join(dir, rel)) };
  });
  const linked = new Map<string, string>();
  const danglingLinks: Array<IndexHealth["danglingLinks"][number]> = [];
  const seenDangling = new Set<string>();
  for (const item of resolved) {
    if (item === null) continue;
    if (item.exists) {
      if (!linked.has(comparablePath(item.rel))) linked.set(comparablePath(item.rel), item.rel);
      continue;
    }
    const key = `${String(item.line)}:${item.rel}`;
    if (seenDangling.has(key)) continue;
    seenDangling.add(key);
    danglingLinks.push({ line: item.line, target: item.rel });
  }

  let topLevel: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    topLevel = entries
      .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== ENTRYPOINT_NAME)
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    topLevel = [];
  }

  return {
    hasFrontmatter: scan?.hasFrontmatter ?? false,
    longEntries: scan ? [...scan.longEntries] : [],
    danglingLinks,
    orphans: topLevel.filter((name) => !linked.has(comparablePath(name))),
    linkedFiles: [...linked.values()].sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * index 内で `fromRel` (index のディレクトリから見た相対パス) を指すリンクを
 * `toRel` に張り替える。 アンカー (`#...`) と `./` 接頭辞は保つ。
 */
export function retargetIndexLinks(
  raw: string,
  fromRel: string,
  toRel: string,
): { text: string; count: number } {
  const from = comparablePath(fromRel);
  const segments = splitSegments(raw);
  const { entries } = walkEntries(segments);
  let count = 0;
  for (const { index, links, rewritable } of entries) {
    if (!rewritable) continue;
    const targets = links.filter((span) => comparablePath(span.target) === from);
    if (targets.length === 0) continue;
    let line = segments[index] ?? "";
    // 後ろから置き換えると前方の位置がずれない。
    for (const span of [...targets].reverse()) {
      const inner = span.raw.startsWith("<") ? span.raw.slice(1, -1) : span.raw;
      const anchor = /[?#].*$/.exec(inner)?.[0] ?? "";
      const dotSlash = inner.startsWith("./") ? "./" : "";
      line =
        line.slice(0, span.start) +
        formatLinkTarget(`${dotSlash}${toRel}`, anchor) +
        line.slice(span.end);
      count++;
    }
    segments[index] = line;
  }
  return { text: segments.join(""), count };
}

/**
 * index から `targetRel` だけを指しているエントリ行を取り除く (他のリンクも
 * 含む行は残す)。 削除した memory のポインタ掃除に使う。
 */
export function removeIndexEntries(
  raw: string,
  targetRel: string,
): { text: string; count: number } {
  const target = comparablePath(targetRel);
  const segments = splitSegments(raw);
  const { entries } = walkEntries(segments);
  const drop = new Set<number>();
  for (const { index, links, rewritable } of entries) {
    if (!rewritable) continue;
    if (links.length > 0 && links.every((span) => comparablePath(span.target) === target)) {
      drop.add(index);
    }
  }
  return {
    text: segments.filter((_, i) => !drop.has(i)).join(""),
    count: drop.size,
  };
}

export { buildIndexEntry, formatLinkTarget } from "@shared/util/indexEntry.ts";

/** index ファイルのパス (memoryDir 直下の MEMORY.md)。 */
export function indexPathFor(memoryDir: string): string {
  return join(memoryDir, ENTRYPOINT_NAME);
}
