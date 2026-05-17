import { parse as parseYaml } from "yaml";

import { type MemoryType, parseMemoryType } from "@shared/schema/memory.ts";

/**
 * YAML frontmatter (--- で囲まれたブロック) のパースと書き戻し。
 *
 * 公式実装 (src/utils/frontmatterParser.ts) と合わせて以下を満たす:
 *   - 先頭 `---\n` ... `\n---\n?` を frontmatter として認識
 *   - パース失敗時は frontmatter null、raw 全体を body として保持 (壊さない)
 *   - frontmatter が object 以外 (配列/スカラー) も null フォールバック
 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export type Frontmatter = Readonly<Record<string, unknown>>;

export type ParsedDocument = {
  readonly frontmatter: Frontmatter | null;
  readonly body: string;
};

export function parseFrontmatter(raw: string): ParsedDocument {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match || match[1] === undefined) {
    return { frontmatter: null, body: raw };
  }
  const yamlText = match[1];
  const body = raw.slice(match[0].length);
  try {
    const parsed: unknown = parseYaml(yamlText);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return {
        frontmatter: parsed as Frontmatter,
        body,
      };
    }
    return { frontmatter: null, body: raw };
  } catch {
    return { frontmatter: null, body: raw };
  }
}

/**
 * frontmatter から MemoryType を抽出。
 *
 * 公式実装は `frontmatter.type` (フラット) を見る。
 * memlens では auto memory プロンプトが `metadata.type` (ネスト) を採用しているので
 * 後者もフォールバックで読む。両方無ければ null。
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
 * 公式 MEMORY_FRONTMATTER_EXAMPLE (src/memdir/memoryTypes.ts:261) を採用:
 *   ---
 *   name: ...
 *   description: ...
 *   type: user|feedback|project|reference
 *   ---
 */
export function buildFrontmatterText(input: {
  readonly name: string;
  readonly description: string;
  readonly type: MemoryType;
}): string {
  const yamlEscape = (s: string): string => {
    if (/[:#>|&*!%@`'"\n]/.test(s)) {
      return JSON.stringify(s);
    }
    return s;
  };
  return [
    "---",
    `name: ${yamlEscape(input.name)}`,
    `description: ${yamlEscape(input.description)}`,
    `type: ${input.type}`,
    "---",
    "",
  ].join("\n");
}
