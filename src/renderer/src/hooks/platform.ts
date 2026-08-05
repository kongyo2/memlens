import type { Dict } from "../i18n/index.ts";

/**
 * preload が晒す process.platform を UI 文言に写す helper。
 *
 * ファイルマネージャの呼び名は OS ごとに固有名詞が違う (Explorer / Finder) ので
 * 単一キーにせず platform で出し分ける。
 */
export function revealLabel(t: Dict, platform: string): string {
  if (platform === "win32") return t.app.revealWin;
  if (platform === "darwin") return t.app.revealMac;
  return t.app.revealLinux;
}

/** ショートカット表示用の修飾キー表記 (macOS だけ ⌘)。 */
export function modKeyLabel(platform: string): string {
  return platform === "darwin" ? "⌘" : "Ctrl+";
}
