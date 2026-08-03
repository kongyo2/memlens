/**
 * BrowserWindow の navigation / window-open 判定 (pure)。
 *
 * main/index.ts の will-navigate / setWindowOpenHandler から使う。 electron に
 * 依存しない形で切り出してユニットテストできるようにしている。
 *
 *   - "allow"    … そのまま遷移させる (dev server と同一 origin のみ)
 *   - "external" … 遷移は block し、 default browser で開く (http/https/mailto)
 *   - "deny"     … 遷移も外部オープンもしない (file: や独自スキーム、 不正 URL)
 *
 * dev origin の比較は URL.origin で行う。 prefix (startsWith) 比較だと
 * `http://localhost:5173@evil.example` のような userinfo 付き URL がすり抜けて
 * 攻撃者ページが preload 付きで開けてしまう (origin は evil.example になるので
 * origin 比較なら弾ける)。
 *
 * shell.openExternal に渡してよいのは http/https/mailto だけに絞る。 file: や
 * 独自プロトコルを OS に丸投げすると任意アプリ起動の踏み台になりうる。
 */
export type NavigationDecision = "allow" | "external" | "deny";

const EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set([
  "http:",
  "https:",
  "mailto:",
]);

export function decideNavigation(
  rawUrl: string,
  allowedOrigin: string | null,
): NavigationDecision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "deny";
  }
  if (allowedOrigin !== null && url.origin === allowedOrigin) {
    return "allow";
  }
  if (EXTERNAL_PROTOCOLS.has(url.protocol)) {
    return "external";
  }
  return "deny";
}

/** URL 文字列から比較用 origin を作る (未設定 / 不正なら null)。 */
export function originOf(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
}
