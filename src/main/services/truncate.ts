import { MEMORY_CONSTANTS } from "@shared/schema/memory.ts";

/**
 * 公式 truncateEntrypointContent (src/memdir/memdir.ts:57) の再実装。
 *
 *   - 200 行と 25_000 bytes の両方をチェック
 *   - 行 truncate を先 (自然な境界)、その後にバイト境界で再 truncate
 *   - byte truncate は最後の改行で切る
 *   - 末尾に発火した制限を名指しした WARNING を付加
 */
export type EntrypointTruncation = {
  readonly content: string;
  readonly lineCount: number;
  readonly byteCount: number;
  readonly wasLineTruncated: boolean;
  readonly wasByteTruncated: boolean;
};

export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const { MAX_ENTRYPOINT_LINES, MAX_ENTRYPOINT_BYTES, ENTRYPOINT_NAME } =
    MEMORY_CONSTANTS;
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {
      content: "",
      lineCount: 0,
      byteCount: 0,
      wasLineTruncated: false,
      wasByteTruncated: false,
    };
  }
  const contentLines = trimmed.split("\n");
  const lineCount = contentLines.length;
  const byteCount = trimmed.length;
  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES;
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES;

  if (!wasLineTruncated && !wasByteTruncated) {
    return {
      content: trimmed,
      lineCount,
      byteCount,
      wasLineTruncated,
      wasByteTruncated,
    };
  }

  let truncated = wasLineTruncated
    ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join("\n")
    : trimmed;

  if (truncated.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf("\n", MAX_ENTRYPOINT_BYTES);
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES);
  }

  const reason =
    wasByteTruncated && !wasLineTruncated
      ? `${formatBytes(byteCount)} (limit: ${formatBytes(MAX_ENTRYPOINT_BYTES)}) — index entries are too long`
      : wasLineTruncated && !wasByteTruncated
        ? `${String(lineCount)} lines (limit: ${String(MAX_ENTRYPOINT_LINES)})`
        : `${String(lineCount)} lines and ${formatBytes(byteCount)}`;

  return {
    content:
      truncated +
      `\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
