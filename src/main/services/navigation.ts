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

const EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"]);

export function decideNavigation(rawUrl: string, allowedOrigin: string | null): NavigationDecision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "deny";
  }
  // "allow" は http/https の同一 origin に限る。 file: / data: / blob: 等の
  // opaque origin は一律 `"null"` (literal) になるため、 allowedOrigin 側が
  // 誤って opaque な URL から導出されていた場合に等価比較だけだと任意の
  // opaque URL が in-window 遷移できてしまう (originOf 側でも弾くが二重に守る)。
  if (
    allowedOrigin !== null &&
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.origin === allowedOrigin
  ) {
    return "allow";
  }
  if (EXTERNAL_PROTOCOLS.has(url.protocol)) {
    return "external";
  }
  return "deny";
}

/**
 * URL 文字列から比較用 origin を作る (未設定 / 不正なら null)。
 *
 * dev server (Vite) は http/https のみなので、 それ以外のスキームからは origin
 * を導出しない。 file: 等は URL.origin が opaque な `"null"` になり、 これを
 * allowedOrigin に渡すとあらゆる opaque URL と一致してしまう。
 */
export function originOf(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}
