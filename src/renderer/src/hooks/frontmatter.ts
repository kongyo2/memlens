import type { MemoryHeader, MemoryType } from "@shared/api/contract.ts";

/**
 * Renderer 側で表示用に frontmatter を解釈する helper。
 *
 * main 側 (`extractMemoryType`, `extractStringField`) と同じルールを使うが、
 * renderer は ParsedMemoryFile.frontmatter (任意 record) を受け取るだけなので
 * ここで読み直す。 root の `type` が無ければ `metadata.type` を fallback。
 */

const ALLOWED_TYPES: readonly MemoryType[] = ["user", "feedback", "project", "reference"];

export function extractType(
  frontmatter: Readonly<Record<string, unknown>> | null,
): MemoryType | null {
  if (!frontmatter) return null;
  const root = parseType(frontmatter["type"]);
  if (root) return root;
  const metadata = frontmatter["metadata"];
  if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
    const nested = parseType((metadata as Record<string, unknown>)["type"]);
    if (nested) return nested;
  }
  return null;
}

function parseType(v: unknown): MemoryType | null {
  if (typeof v !== "string") return null;
  return ALLOWED_TYPES.includes(v as MemoryType) ? (v as MemoryType) : null;
}

export function extractString(
  frontmatter: Readonly<Record<string, unknown>> | null,
  key: string,
): string | null {
  if (!frontmatter) return null;
  const v = frontmatter[key];
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export type DisplayMeta = {
  readonly title: string;
  readonly description: string | null;
  readonly type: MemoryType | null;
};

export function extractDisplayMeta(
  frontmatter: Readonly<Record<string, unknown>> | null,
  header: MemoryHeader,
): DisplayMeta {
  const name = extractString(frontmatter, "name");
  const description = extractString(frontmatter, "description");
  const type = extractType(frontmatter);
  return {
    title: name ?? header.name ?? header.filename,
    description: description ?? header.description,
    type: type ?? header.type,
  };
}
