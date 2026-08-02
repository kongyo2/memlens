import {
  type EntrypointTruncation,
  truncateEntrypointContent,
} from "./truncate.ts";

/**
 * MEMORY.md が実際にセッションへロードされる内容の再現。
 *
 * 公式のロード経路 (src/utils/claudemd.ts parseMemoryFileContent, type='AutoMem') は
 *   1. YAML frontmatter ブロックを除去 (utils/frontmatterParser.ts FRONTMATTER_REGEX)
 *   2. block-level HTML コメントを除去 (`<!--` を含むときだけ marked Lexer で strip)
 *   3. truncateEntrypointContent で 200 行 / 25KB に切る
 * の順で処理する。 つまり 200 行 / 25KB の測定は 1-2 適用後の内容に対して行われる
 * (docs/memory.md min-version 2.1.211: "YAML frontmatter and block-level HTML
 * comments are stripped before the index is loaded, so they don't count toward
 * the limits")。 raw をそのまま truncate すると、 frontmatter やコメント付きの
 * MEMORY.md で「実際は収まっているのに超過表示」(またはその逆) になる。
 */

/**
 * 公式 FRONTMATTER_REGEX (src/utils/frontmatterParser.ts:123) と同一のパターン。
 *
 * 公式 parseFrontmatter は YAML パースの成否に関係なく `content` を
 * `markdown.slice(match[0].length)` で切り出すので、 壊れた YAML でも
 * frontmatter ブロック自体はロード対象から外れる。 閉じ `---` は行頭である
 * 必要がない (non-greedy で最初の `---` まで) という公式の癖もそのまま踏襲する。
 */
const FRONTMATTER_BLOCK_RE = /^---\s*\n([\s\S]*?)---\s*\n?/;

export function stripFrontmatterBlock(raw: string): string {
  const m = FRONTMATTER_BLOCK_RE.exec(raw);
  return m ? raw.slice(m[0].length) : raw;
}

/** 整形式の HTML コメント 1 スパン。 non-greedy なので同一行の複数コメントも個別に落ちる。 */
const COMMENT_SPAN_RE = /<!--[\s\S]*?-->/g;
/** CommonMark type-2 HTML block の開始条件: 先頭 3 space までのインデント + `<!--`。 */
const COMMENT_START_RE = /^ {0,3}<!--/;
/** fenced code block の開始 (``` or ~~~, info string 可)。 */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** fenced code block の終了 (同種の fence 文字のみ + 末尾空白)。 */
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * block-level の HTML コメントを除去する。
 *
 * 公式 stripHtmlComments (src/utils/claudemd.ts:292) は marked の Lexer で
 * block token を判定するが、 memlens は marked に依存しないため CommonMark の
 * HTML block (type 2) 規則を行ベースで再現する:
 *
 *   - 開始: インデント 3 space 以下で `<!--` から始まる行 (段落の途中でも
 *     interrupt する)
 *   - 終了: `-->` を含む行 (開始行自身でもよい)。 `-->` より後ろの残余テキストは
 *     公式同様保持する
 *   - 未クローズ (`-->` が最後まで無い) コメントはそのまま残す
 *   - fenced code block (``` / ~~~) 内と、 行中のインライン コメントは残す
 *
 * marked と厳密に一致しない既知の差分はリスト内にネストしたコメント
 * (公式は list token 内部を走査しないため残すが、 本実装は落とす) のみで、
 * 実運用の MEMORY.md では発生しない形。 公式が strip 時に CRLF を LF へ
 * 正規化する挙動 (marked lexer の仕様) も合わせている。
 */
export function stripBlockHtmlComments(content: string): string {
  if (!content.includes("<!--")) return content;
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let fence: { readonly char: string; readonly len: number } | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (fence !== null) {
      out.push(line);
      const close = FENCE_CLOSE_RE.exec(line);
      const marker = close?.[1];
      if (
        marker !== undefined &&
        marker.startsWith(fence.char) &&
        marker.length >= fence.len
      ) {
        fence = null;
      }
      i++;
      continue;
    }
    const open = FENCE_OPEN_RE.exec(line);
    const openMarker = open?.[1];
    if (openMarker !== undefined) {
      const info = open?.[2] ?? "";
      // CommonMark: backtick fence の info string に backtick は使えない
      // (その行は fence にならない)。 tilde fence には制約なし。
      if (!(openMarker.startsWith("`") && info.includes("`"))) {
        fence = { char: openMarker.charAt(0), len: openMarker.length };
        out.push(line);
        i++;
        continue;
      }
    }
    if (COMMENT_START_RE.test(line)) {
      let j = i;
      while (j < lines.length && !(lines[j] ?? "").includes("-->")) j++;
      if (j >= lines.length) {
        // 未クローズ → typo でファイルの残りが丸ごと消えないよう残す (公式と同じ)。
        out.push(line);
        i++;
        continue;
      }
      const residue = lines
        .slice(i, j + 1)
        .join("\n")
        .replace(COMMENT_SPAN_RE, "");
      if (residue.trim().length > 0) {
        // 残余あり (e.g. `<!-- note --> Use bun`) は保持する。
        out.push(...residue.split("\n"));
      } else {
        // 公式の marked token はコメント直後の空行まで raw に含むため、
        // コメントだけの block を落とすときは後続の空行も一緒に消える。
        while (j + 1 < lines.length && (lines[j + 1] ?? "").trim().length === 0)
          j++;
      }
      i = j + 1;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}

/**
 * raw な MEMORY.md 内容から「Claude Code が実際にロードする内容」と、
 * その内容に対する 200 行 / 25KB 測定値を計算する。
 *
 * BOM は先頭で除去する。 (公式 scan 経路の readFileInRange は BOM を strip する。
 * claudemd 経路は raw 読みのため BOM + frontmatter の複合ケースで公式内でも
 * 挙動が揺れるが、 Claude Code 自身は BOM を書かないので、 memlens は常に
 * strip して決定的なプレビューを出す。)
 */
export function computeLoadedIndex(raw: string): EntrypointTruncation {
  const noBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const withoutFrontmatter = stripFrontmatterBlock(noBom);
  const stripped = stripBlockHtmlComments(withoutFrontmatter);
  return truncateEntrypointContent(stripped);
}
