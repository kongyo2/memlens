import { MEMORY_CONSTANTS } from "@shared/schema/memory.ts";

/**
 * 公式 sanitizePath (src/utils/sessionStoragePortable.ts:311) の再実装。
 *
 *   1. 非英数字をすべて `-` に置換
 *   2. 200 chars を超えたら `<slice>-<hash>` で短縮 (djb2 base36)
 *
 * Node 環境では Bun.hash が無いので djb2Hash を使う (公式の simpleHash と同等)。
 */
export function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= MEMORY_CONSTANTS.MAX_SANITIZED_LENGTH) {
    return sanitized;
  }
  return `${sanitized.slice(0, MEMORY_CONSTANTS.MAX_SANITIZED_LENGTH)}-${djb2Hash(name)}`;
}

/**
 * djb2 ハッシュの絶対値を base36 で返す。公式 simpleHash と同じ計算式。
 *
 * `Math.imul` を使うため 32bit 範囲で wrap する。負の値は `Math.abs` で吸収。
 */
function djb2Hash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(hash, 33) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * sanitize 済みフォルダ名から元のディレクトリ path を best-effort で復元。
 *
 * エンコードは破壊的 (任意の非英数字が `-`) なので完全復元は不可能。
 * 表示用ヒントとしてのみ使うこと (UI で「もとはこのパス?」と提示する目的)。
 *
 * 推定パターン:
 *   - `C--Users-...`     → `C:\Users\...` (Windows ドライブ)
 *   - 先頭 `-`           → `/`            (POSIX ルート)
 *   - それ以外           → null
 */
export function guessProjectPath(encoded: string): string | null {
  const windowsMatch = /^([A-Za-z])--(.+)$/.exec(encoded);
  if (
    windowsMatch &&
    windowsMatch[1] !== undefined &&
    windowsMatch[2] !== undefined
  ) {
    const drive = windowsMatch[1].toUpperCase();
    const rest = windowsMatch[2].replaceAll("-", "\\");
    return `${drive}:\\${rest}`;
  }
  if (encoded.startsWith("-")) {
    return "/" + encoded.slice(1).replaceAll("-", "/");
  }
  return null;
}
