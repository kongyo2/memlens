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
 * 書き戻しは `yaml.stringify` を使う (自前のクオート判定をしない)。
 */

export type Frontmatter = Readonly<Record<string, unknown>>;

export type ParsedDocument = {
  readonly frontmatter: Frontmatter | null;
  readonly body: string;
};

const FENCE_RE = /^---\r?\n/;

export function parseFrontmatter(raw: string): ParsedDocument {
  if (!FENCE_RE.test(raw)) {
    return { frontmatter: null, body: raw };
  }
  try {
    const parsed = matter(raw);
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
 * 公式実装は `frontmatter.type` (フラット) を見る。 memlens では auto memory
 * プロンプトが `metadata.type` (ネスト) を採用しているので後者も fallback で読む。
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
