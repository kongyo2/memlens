import { Lexer } from "marked";

import { type EntrypointTruncation, truncateEntrypointContent } from "./truncate.ts";

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

/**
 * block-level の HTML コメントを除去する。
 *
 * 公式 stripHtmlCommentsFromTokens (src/utils/claudemd.ts:303) の忠実移植で、
 * 公式と同じ marked の block lexer (gfm: false) を使う。 top-level の html
 * token のうち整形式コメントで始まるものだけを対象に、 コメントスパンを除去し
 * 残余テキスト (`<!-- note --> Use bun` の後半など) は保持する:
 *
 *   - fenced code block 内 / 段落中のインラインコメントは残る (html token に
 *     ならない)
 *   - list item にネストしたコメントも残る (top-level token は list であり、
 *     公式は list token の内部を走査しない)
 *   - 未クローズ (`-->` が最後まで無い) コメントはそのまま残す
 *
 * marked は lex 時に CRLF を LF へ正規化するため、 コメントを実際に除去した
 * ケースでは出力の改行が LF に揃う (公式 parseMemoryFileContent も同じ)。
 */
export function stripBlockHtmlComments(content: string): string {
  if (!content.includes("<!--")) return content;
  const tokens = new Lexer({ gfm: false }).lex(content);
  let out = "";
  for (const token of tokens) {
    if (token.type === "html") {
      const trimmed = token.raw.trimStart();
      if (trimmed.startsWith("<!--") && trimmed.includes("-->")) {
        // CommonMark の type-2 HTML block は `-->` を含む行末までが 1 token。
        // スパンだけ除去し、 同一行の残余があれば保持する。
        const residue = token.raw.replace(COMMENT_SPAN_RE, "");
        if (residue.trim().length > 0) {
          out += residue;
        }
        continue;
      }
    }
    out += token.raw;
  }
  return out;
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
