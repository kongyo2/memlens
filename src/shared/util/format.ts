/**
 * Display formatters shared by main and renderer.
 *
 * `formatFileSize` matches 公式 (src/utils/format.ts:9): no space, "bytes" not
 * "B", ".0" trimmed. truncate.ts の WARNING 文字列がそのまま公式と一致するために
 * このフォーマットを使う。
 */
export function formatFileSize(sizeInBytes: number): string {
  const kb = sizeInBytes / 1024;
  if (kb < 1) {
    return `${String(sizeInBytes)} bytes`;
  }
  if (kb < 1024) {
    return `${kb.toFixed(1).replace(/\.0$/, "")}KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(1).replace(/\.0$/, "")}MB`;
  }
  const gb = mb / 1024;
  return `${gb.toFixed(1).replace(/\.0$/, "")}GB`;
}

/**
 * 公式 memoryAgeDays (src/memdir/memoryAge.ts:6) と同等。 マイナス値 (clock skew)
 * は 0 に clamp。
 */
export function memoryAgeDays(mtimeMs: number, nowMs: number = Date.now()): number {
  return Math.max(0, Math.floor((nowMs - mtimeMs) / 86_400_000));
}
