import { MEMORY_CONSTANTS } from "@shared/schema/memory.ts";

/**
 * 公式 sanitizePath (src/utils/sessionStoragePortable.ts:311) の再実装。
 *
 *   1. 非英数字をすべて `-` に置換
 *   2. 200 chars を超えたら `<slice>-<hash>` で短縮 (base36)
 *
 * 公式は Bun.hash (wyhash) を優先しつつ、Node 環境では simpleHash = djb2Hash に
 * フォールバックする (src/utils/hash.ts:7)。 memlens は Node 環境のみで動くので
 * 後者を使う。 アルゴリズムは公式と完全一致させる:
 *   - hash 初期値 = 0  (5381 ではない)
 *   - hash = ((hash << 5) - hash + ch) | 0    ※ 31 倍。 33 倍 ではない
 *   - Math.abs(hash).toString(36)
 *
 * これが揃わないと、長い path (>200 chars) で公式が生成する hash 接尾辞と
 * 一致せず、 ~/.claude/projects/<sanitized> の検索が外れる。
 */
export function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= MEMORY_CONSTANTS.MAX_SANITIZED_LENGTH) {
    return sanitized;
  }
  return `${sanitized.slice(0, MEMORY_CONSTANTS.MAX_SANITIZED_LENGTH)}-${simpleHash(name)}`;
}

/** 公式 src/utils/hash.ts:7 と完全一致する djb2 変種 (実体は Java String#hashCode)。 */
function djb2Hash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

/** 公式 simpleHash (src/utils/sessionStoragePortable.ts:295)。 */
function simpleHash(str: string): string {
  return Math.abs(djb2Hash(str)).toString(36);
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
  if (windowsMatch && windowsMatch[1] !== undefined && windowsMatch[2] !== undefined) {
    const drive = windowsMatch[1].toUpperCase();
    const rest = windowsMatch[2].replaceAll("-", "\\");
    return `${drive}:\\${rest}`;
  }
  if (encoded.startsWith("-")) {
    return "/" + encoded.slice(1).replaceAll("-", "/");
  }
  return null;
}
