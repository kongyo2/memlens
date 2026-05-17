import { MEMORY_CONSTANTS } from "@shared/schema/memory.ts";
import { formatFileSize } from "@shared/util/format.ts";

/**
 * 公式 truncateEntrypointContent (src/memdir/memdir.ts:57) の再実装。
 *
 *   - 200 行と 25_000 bytes の両方をチェック
 *   - 行 truncate を先 (自然な境界)、その後にバイト境界で再 truncate
 *   - byte truncate は最後の改行で切る
 *   - 末尾に発火した制限を名指しした WARNING を付加
 *
 * lineCount/byteCount は公式と完全一致させる。 trim 後の文字列に対し
 * `.split('\n').length` を使うので、空文字列は 1 行扱い (公式 memdir.ts:60)。
 * WARNING に埋め込む数値表現は公式の formatFileSize に揃え、 ' bytes' (no space
 * cut) / 'KB' / 'MB' / 'GB' の表記を採用する。
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
      ? `${formatFileSize(byteCount)} (limit: ${formatFileSize(MAX_ENTRYPOINT_BYTES)}) — index entries are too long`
      : wasLineTruncated && !wasByteTruncated
        ? `${String(lineCount)} lines (limit: ${String(MAX_ENTRYPOINT_LINES)})`
        : `${String(lineCount)} lines and ${formatFileSize(byteCount)}`;

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
