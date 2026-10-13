import { MEMORY_CONSTANTS } from "@shared/schema/memory.ts";

/**
 * 公式 truncateEntrypointContent (src/memdir/memdir.ts:57) の再実装。
 *
 *   - 200 行と 25_000 (string length) の両方をチェック
 *   - 行 truncate を先 (自然な境界)、その後にバイト境界で再 truncate
 *   - byte truncate は最後の改行で切る
 *
 * lineCount/byteCount は公式と完全一致させる。 trim 後の文字列に対し
 * `.split('\n').length` を使うので、空文字列は 1 行扱い (公式 memdir.ts:60)。
 *
 * 公式はロード内容の末尾に WARNING を付けるが、 その文言は v2.1.268 で
 * 「何行切れたか・どこから切れたか」を含む形に変わった (changelog)。 古い文言を
 * 複製して見せると実物と食い違うので、 memlens は文言を合成せず、 ロードされる
 * 部分 (content) と切り落とされる部分 (dropped) を分けて返し、 UI 側で
 * 切断位置と行数を示す。
 */
export type EntrypointTruncation = {
  /** Claude Code がロードする部分 (trim 済み)。 */
  readonly content: string;
  /** 上限で切り落とされる部分 (切られていなければ空文字)。 */
  readonly dropped: string;
  readonly lineCount: number;
  readonly byteCount: number;
  /** ロードされる行数。 */
  readonly loadedLineCount: number;
  readonly wasLineTruncated: boolean;
  readonly wasByteTruncated: boolean;
};

export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const { MAX_ENTRYPOINT_LINES, MAX_ENTRYPOINT_BYTES } = MEMORY_CONSTANTS;
  const trimmed = raw.trim();
  const contentLines = trimmed.split("\n");
  const lineCount = contentLines.length;
  const byteCount = trimmed.length;
  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES;
  // 公式と同じく元の長さで判定する (長い行こそ byte 上限が狙う失敗パターン)。
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES;

  if (!wasLineTruncated && !wasByteTruncated) {
    return {
      content: trimmed,
      dropped: "",
      lineCount,
      byteCount,
      loadedLineCount: lineCount,
      wasLineTruncated,
      wasByteTruncated,
    };
  }

  let loaded = wasLineTruncated ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join("\n") : trimmed;
  if (loaded.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = loaded.lastIndexOf("\n", MAX_ENTRYPOINT_BYTES);
    loaded = loaded.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES);
  }
  // loaded は常に trimmed の接頭辞なので、 残りがそのまま切り落とされる部分
  // (切断位置の改行は除く)。
  const dropped = trimmed.slice(loaded.length).replace(/^\n/, "");

  return {
    content: loaded,
    dropped,
    lineCount,
    byteCount,
    loadedLineCount: loaded.length === 0 ? 0 : loaded.split("\n").length,
    wasLineTruncated,
    wasByteTruncated,
  };
}
