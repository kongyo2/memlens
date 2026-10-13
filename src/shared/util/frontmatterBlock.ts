/**
 * frontmatter ブロック (`---` で囲まれた先頭部分) の切り出し。 YAML の解釈は
 * しない (main の parseFrontmatter が担当)。 renderer も編集中のバッファを
 * プレビューするときに同じ境界で分けるので shared に置く。
 */

/** 公式 FRONTMATTER_REGEX (src/utils/frontmatterParser.ts:123) と同一。 */
const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)---\s*\n?/;

export type FrontmatterSplit = {
  /** フェンスの内側 (YAML テキスト)。 フェンスが無ければ null。 */
  readonly yaml: string | null;
  /**
   * フェンスの後ろ。 公式は YAML が読めなくてもブロックを外した残りを content に
   * するので、 ここも YAML の成否に関係なく外す。 フェンスが無ければ入力全体。
   */
  readonly body: string;
};

export function splitFrontmatter(raw: string): FrontmatterSplit {
  // 先頭の UTF-8 BOM は判定前に除く (公式 scan 経路の readFileInRange も strip する)。
  const input = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const match = FRONTMATTER_REGEX.exec(input);
  if (!match) return { yaml: null, body: raw };
  return { yaml: match[1] ?? "", body: input.slice(match[0].length) };
}
