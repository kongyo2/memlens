import { type MemoryType, parseMemoryType } from "@shared/schema/memory.ts";
import { splitFrontmatter } from "@shared/util/frontmatterBlock.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * YAML frontmatter (--- で囲まれたブロック) のパースと書き戻し。
 *
 * 読み出しは公式 parseFrontmatter (src/utils/frontmatterParser.ts:130) の移植:
 *   1. FRONTMATTER_REGEX でブロックを切り出す (shared/util/frontmatterBlock.ts)
 *   2. `yaml` で parse (公式の Node 経路と同じライブラリ)
 *   3. 失敗したら quoteProblematicValues で特殊文字を含む値をクオートして再試行
 *
 * 3 が重要で、 Claude は `description: Testing policy: always hit a real DB` の
 * ような「値の途中に `: `」を普通に書く。 素の YAML としては invalid だが公式は
 * 再試行で読めるため、 ここで諦めると memlens だけ name/description/type が
 * 消えて見えていた (旧実装の gray-matter = js-yaml は再試行しない)。 `yaml` は
 * YAML 1.2 core schema なので `modified: 2026-07-18T10:00:00Z` も Date に化けず
 * 文字列のまま返る。
 *
 * memlens の API 形:
 *   - 区切り無し → frontmatter: null, body: 入力全体
 *   - 区切りあり → body はブロックの後ろ (公式の content と同じく YAML の成否に
 *     関係なく外す)
 *   - 再試行でもパース失敗 → frontmatter: null, invalid: true (壊れたブロックは
 *     renderer が raw から切り出して見せる)
 *   - 配列 / スカラー / 空 object → frontmatter: null
 *
 * 先頭の UTF-8 BOM は判定前に除去する (公式 scan 経路の readFileInRange も
 * strip する)。 CRLF はブロック内だけ LF に揃えてから parse する — 公式の
 * quote 再試行は `\r` が残ると行 regex が一致しない。
 */

export type Frontmatter = Readonly<Record<string, unknown>>;

export type ParsedDocument = {
  readonly frontmatter: Frontmatter | null;
  readonly body: string;
  /** フェンスはあるが YAML として読めなかった (公式の quote 再試行後も失敗)。 */
  readonly invalid: boolean;
};

/**
 * 公式 YAML_SPECIAL_CHARS (src/utils/frontmatterParser.ts:79)。 クオート無しだと
 * YAML の構文として解釈される文字 (`: ` は compact mapping の key 指示子)。
 */
const YAML_SPECIAL_CHARS = /[{}[\]*&#!|>%@`]|: /;

/**
 * 公式 quoteProblematicValues の移植。 単純な `key: value` 行 (インデント無し・
 * 未クオート) のうち特殊文字を含む値を二重引用符でくくる。
 */
function quoteProblematicValues(frontmatterText: string): string {
  return frontmatterText
    .split("\n")
    .map((line) => {
      const match = /^([a-zA-Z_-]+):\s+(.+)$/.exec(line);
      if (!match) return line;
      const [, key, value] = match;
      if (!key || !value) return line;
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        return line;
      }
      if (!YAML_SPECIAL_CHARS.test(value)) return line;
      const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `${key}: "${escaped}"`;
    })
    .join("\n");
}

function tryParseYaml(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    // logLevel "error": 警告は main process の stderr に流さない (エラーは throw)。
    return { ok: true, value: parseYaml(text, { logLevel: "error" }) };
  } catch {
    return { ok: false };
  }
}

function asFrontmatter(value: unknown): Frontmatter | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return Object.keys(value).length === 0 ? null : (value as Frontmatter);
}

export function parseFrontmatter(raw: string): ParsedDocument {
  const { yaml, body } = splitFrontmatter(raw);
  if (yaml === null) {
    return { frontmatter: null, body, invalid: false };
  }
  const text = yaml.replace(/\r\n/g, "\n");
  const first = tryParseYaml(text);
  const parsed = first.ok ? first : tryParseYaml(quoteProblematicValues(text));
  if (!parsed.ok) {
    return { frontmatter: null, body, invalid: true };
  }
  return { frontmatter: asFrontmatter(parsed.value), body, invalid: false };
}

/**
 * frontmatter から MemoryType を抽出。
 *
 * 公式実装 (src/memdir/memoryTypes.ts:28) は `frontmatter.type` (root レベル) を
 * 見る。 memlens は root を優先しつつ、 3rd-party ツールが書きうる
 * `metadata.type` (ネスト) も defensive fallback で許容する — UI 上で「タイプ
 * 不明 (?)」になる頻度を減らすためで、 新規書き出しは常に root に置く
 * (buildFrontmatterText 参照)。
 */
export function extractMemoryType(frontmatter: Frontmatter | null): MemoryType | null {
  if (!frontmatter) return null;
  const root = parseMemoryType(frontmatter["type"]);
  if (root) return root;
  const metadata = frontmatter["metadata"];
  if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
    const nested = parseMemoryType((metadata as Record<string, unknown>)["type"]);
    if (nested) return nested;
  }
  return null;
}

export function extractStringField(frontmatter: Frontmatter | null, key: string): string | null {
  if (!frontmatter) return null;
  const value = frontmatter[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** ISO 8601 の日付 / 日時 (秒・小数秒・タイムゾーンは任意)。 */
const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}(?::?\d{2})?)?)?$/;

/**
 * `modified` frontmatter (Claude Code v2.1.214+ が書き込み時刻を ISO 8601 で
 * 記録する) を epoch ms で返す。 無い / 読めないときは null。
 *
 * docs/memory.md: "The timestamp shows how current the fact is, both to you and
 * to Claude when it reads the memory back." — fs の mtime は git checkout や
 * クラウド同期で動くが、 こちらは内容と一緒に移動する。
 */
export function extractModifiedMs(frontmatter: Frontmatter | null): number | null {
  if (!frontmatter) return null;
  const value = frontmatter["modified"];
  // YAML 1.1 系のツールが書き直したファイルでも読めるよう Date も受ける。
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!ISO_8601_RE.test(trimmed)) return null;
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * memlens が新規ファイル作成時に書き出す canonical な frontmatter テキスト。
 *
 * 公式 MEMORY_FRONTMATTER_EXAMPLE (src/memdir/memoryTypes.ts:261) に倣い
 * root に type を置き、 v2.1.214+ と同じく `modified` を添える。 YAML 整形は
 * `yaml` パッケージに委譲 (自前クオートしない)。
 */
export function buildFrontmatterText(input: {
  readonly name: string;
  readonly description: string;
  readonly type: MemoryType;
  readonly modified?: string;
}): string {
  const body = stringifyYaml({
    name: input.name,
    description: input.description,
    type: input.type,
    ...(input.modified === undefined ? {} : { modified: input.modified }),
  });
  // `yaml.stringify` 出力には末尾改行があるので、区切りはそれをそのまま閉じる形にする。
  return `---\n${body}---\n`;
}

const FENCE_LINE_RE = /^---[^\S\r\n]*$/;
const MODIFIED_KEY_RE = /^(?:modified|"modified"|'modified')[^\S\r\n]*:/;

/** `modified` 以外のキーを比較用に文字列化する (YAML 1.2 core schema なので JSON に載る)。 */
function otherKeys(frontmatter: Frontmatter): string {
  const { modified: _modified, ...rest } = frontmatter;
  return JSON.stringify(rest);
}

/**
 * Claude Code v2.1.214+ と同じく、 frontmatter を持つ memory を書くときに
 * `modified` (ISO 8601) を記録する。 frontmatter の無いファイルには追加しない
 * (docs/memory.md: "Claude Code never adds frontmatter to a file that has none")。
 * frontmatter が YAML として読めないときも触らない (壊れたファイルを悪化させない)。
 *
 * YAML を parse → stringify で書き直すとコメント・引用・キー順が崩れ、 2.1.214 で
 * 公式が直した「保存時に inline `#` で値が切れる」事故も起こりうる。 そのため
 * `modified:` 行だけをテキストとして差し替え (無ければ閉じフェンス直前に追加)、
 * 改行コード (CRLF / LF) と BOM は元のまま保つ。 差し込んだ結果は読み直して確かめ、
 * flow mapping (`{name: x}`) や `...` 終端のように行の差し込みで壊れる書き方なら
 * 記録せずに元のまま返す (frontmatter を壊すと Claude Code から name / description /
 * type が見えなくなる)。
 */
export function stampModified(raw: string, iso: string): string {
  const bom = raw.charCodeAt(0) === 0xfeff ? "﻿" : "";
  const text = raw.slice(bom.length);
  // 改行を各行の末尾に残したまま分割する。
  const lines = text.split(/(?<=\n)/);
  const content = (line: string): string => line.replace(/\r?\n$/, "");
  const first = lines[0];
  if (first === undefined || !FENCE_LINE_RE.test(content(first))) return raw;
  const closeIdx = lines.findIndex((line, i) => i > 0 && FENCE_LINE_RE.test(content(line)));
  if (closeIdx < 0) return raw;
  const parsed = parseFrontmatter(text);
  if (parsed.frontmatter === null) return raw;

  const eol = first.endsWith("\r\n") ? "\r\n" : "\n";
  const keyIdx = lines.findIndex((line, i) => i > 0 && i < closeIdx && MODIFIED_KEY_RE.test(line));
  const out = [...lines];
  if (keyIdx >= 0) {
    // ブロックスカラー等で値が次行以降にインデントされて続く場合はそれも置き換える。
    let end = keyIdx + 1;
    while (end < closeIdx && /^[ \t]/.test(out[end] ?? "")) end++;
    const lineEol = (out[keyIdx] ?? "").endsWith("\r\n") ? "\r\n" : "\n";
    out.splice(keyIdx, end - keyIdx, `modified: ${iso}${lineEol}`);
  } else {
    out.splice(closeIdx, 0, `modified: ${iso}${eol}`);
  }
  const next = bom + out.join("");
  const check = parseFrontmatter(next);
  if (
    check.frontmatter === null ||
    check.frontmatter["modified"] !== iso ||
    otherKeys(check.frontmatter) !== otherKeys(parsed.frontmatter)
  ) {
    return raw;
  }
  return next;
}
