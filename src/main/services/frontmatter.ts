import matter from "gray-matter";
import { stringify as stringifyYaml } from "yaml";

import { type MemoryType, parseMemoryType } from "@shared/schema/memory.ts";

/**
 * YAML frontmatter (--- で囲まれたブロック) のパースと書き戻し。
 *
 * 読み出しは `gray-matter` に委譲し、 memlens の従来 API を満たすよう薄くラップする:
 *   - 区切り無し → frontmatter: null, body: 入力全体
 *   - パース失敗 → frontmatter: null, body: 入力全体 (壊さない)
 *   - 配列 / スカラー → frontmatter: null
 *   - 空 object ({}) も「実質 frontmatter なし」とみなし null
 *
 * 先頭の UTF-8 BOM は判定前に除去する。 公式の scan 経路 (readFileInRange) は
 * BOM を strip してから frontmatter を読むので、 Windows のエディタが付けた
 * BOM で name/description/type が突然消える事故を防ぐ。
 *
 * 書き戻しは `yaml.stringify` を使う (自前のクオート判定をしない)。
 */

export type Frontmatter = Readonly<Record<string, unknown>>;

export type ParsedDocument = {
  readonly frontmatter: Frontmatter | null;
  readonly body: string;
};

/**
 * 開始フェンス。 公式 FRONTMATTER_REGEX (`^---\s*\n`) と同様に `---` の後の
 * 行内空白を許容する (改行を跨ぐ `\s*` は gray-matter が扱えないため行内のみ)。
 */
const FENCE_RE = /^---[^\S\r\n]*\r?\n/;

/**
 * 閉じフェンス (行頭 `---` + 行内空白 + 改行または EOF)。
 *
 * 閉じの無い入力を gray-matter に渡すと、 残り全体が YAML として偶然 valid な
 * 場合に「本文が空 + でっち上げの frontmatter」が返ってしまう (YAML として
 * invalid なら throw して catch 済み)。 公式 FRONTMATTER_REGEX も閉じ区切りを
 * 要求するので、 完全なブロックが無い限り frontmatter なし扱いで本文を守る。
 */
const CLOSING_FENCE_RE = /\r?\n---[^\S\r\n]*(\r?\n|$)/;

export function parseFrontmatter(raw: string): ParsedDocument {
  const input = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (!FENCE_RE.test(input) || !CLOSING_FENCE_RE.test(input)) {
    return { frontmatter: null, body: raw };
  }
  try {
    const parsed = matter(input);
    const data: unknown = parsed.data;
    if (
      typeof data !== "object" ||
      data === null ||
      Array.isArray(data) ||
      Object.keys(data as Record<string, unknown>).length === 0
    ) {
      return { frontmatter: null, body: raw };
    }
    return {
      frontmatter: data as Frontmatter,
      body: parsed.content,
    };
  } catch {
    return { frontmatter: null, body: raw };
  }
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
export function extractMemoryType(
  frontmatter: Frontmatter | null,
): MemoryType | null {
  if (!frontmatter) return null;
  const root = parseMemoryType(frontmatter["type"]);
  if (root) return root;
  const metadata = frontmatter["metadata"];
  if (
    typeof metadata === "object" &&
    metadata !== null &&
    !Array.isArray(metadata)
  ) {
    const nested = parseMemoryType(
      (metadata as Record<string, unknown>)["type"],
    );
    if (nested) return nested;
  }
  return null;
}

export function extractStringField(
  frontmatter: Frontmatter | null,
  key: string,
): string | null {
  if (!frontmatter) return null;
  const value = frontmatter[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * memlens が新規ファイル作成時に書き出す canonical な frontmatter テキスト。
 *
 * 公式 MEMORY_FRONTMATTER_EXAMPLE (src/memdir/memoryTypes.ts:261) に倣い
 * root に type を置く。 YAML 整形は `yaml` パッケージに委譲 (自前クオートしない)。
 */
export function buildFrontmatterText(input: {
  readonly name: string;
  readonly description: string;
  readonly type: MemoryType;
}): string {
  const body = stringifyYaml({
    name: input.name,
    description: input.description,
    type: input.type,
  });
  // `yaml.stringify` 出力には末尾改行があるので、区切りはそれをそのまま閉じる形にする。
  return `---\n${body}---\n`;
}
