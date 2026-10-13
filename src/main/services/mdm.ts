import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";

/**
 * OS レベルの managed policy (MDM) の読み出し。
 *
 * 公式 src/utils/settings/mdm/{constants,rawRead,settings}.ts の移植:
 *   - macOS: `com.anthropic.claudecode` managed preferences。 ユーザ別 →
 *     デバイス全体の順に plist を探し、 最初に読めたものを `plutil` で JSON 化
 *   - Windows: `HKLM\SOFTWARE\Policies\ClaudeCode` の `Settings` 値 (JSON 文字列)。
 *     ユーザが書ける `HKCU` 側は最下位の別ソースとして返す
 *   - Linux: MDM は無い (managed-settings.json のみ)
 *
 * docs/managed-settings.md の順位は remote → MDM (plist / HKLM) → managed
 * settings ファイル → HKCU。 remote (claude.ai から取得する server-managed
 * settings) は memlens からは見えないので、 ここで扱うのは端末上の 2 ソース。
 *
 * サブプロセスは IPC のたびに起こすと遅いので TTL 付きでキャッシュする
 * (公式もセッション中は 30 分ごとの再読込)。
 */

export type RawSettingsObject = Readonly<Record<string, unknown>>;

export type MdmSettings = {
  /** 管理者だけが書ける MDM ソース (macOS plist / Windows HKLM)。 */
  readonly admin: RawSettingsObject | null;
  /** Windows HKCU (ユーザが書ける最下位ソース)。 */
  readonly hkcu: RawSettingsObject | null;
};

const EMPTY: MdmSettings = { admin: null, hkcu: null };

const MACOS_PREFERENCE_DOMAIN = "com.anthropic.claudecode";
const PLUTIL_PATH = "/usr/bin/plutil";
const REGISTRY_KEY_HKLM = "HKLM\\SOFTWARE\\Policies\\ClaudeCode";
const REGISTRY_KEY_HKCU = "HKCU\\SOFTWARE\\Policies\\ClaudeCode";
const REGISTRY_VALUE_NAME = "Settings";
const SUBPROCESS_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 60_000;

/** macOS の managed preferences plist。 優先度の高い順。 */
export function macOSPlistPaths(username: string): string[] {
  const paths: string[] = [];
  if (username.length > 0) {
    paths.push(`/Library/Managed Preferences/${username}/${MACOS_PREFERENCE_DOMAIN}.plist`);
  }
  paths.push(`/Library/Managed Preferences/${MACOS_PREFERENCE_DOMAIN}.plist`);
  return paths;
}

/**
 * 公式 parseRegQueryStdout の移植。 `reg query` の出力から REG_SZ /
 * REG_EXPAND_SZ の値を取り出す:
 *
 *     Settings    REG_SZ    {"json":"value"}
 */
export function parseRegQueryStdout(
  stdout: string,
  valueName = REGISTRY_VALUE_NAME,
): string | null {
  const escaped = valueName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s+${escaped}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)$`, "i");
  for (const line of stdout.split(/\r?\n/)) {
    const match = re.exec(line);
    if (match?.[1]) return match[1].trimEnd();
  }
  return null;
}

/** JSON テキストを settings object として読む (object 以外 / 空 / 壊れは null)。 */
export function parseSettingsJson(text: string): RawSettingsObject | null {
  try {
    const data: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    if (data && typeof data === "object" && !Array.isArray(data) && Object.keys(data).length > 0) {
      return data as RawSettingsObject;
    }
  } catch {
    /* 壊れた JSON はソース無し扱い */
  }
  return null;
}

function run(cmd: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      // windowsHide: GUI から reg.exe を起こしてもコンソール窓を出さない。
      { encoding: "utf8", timeout: SUBPROCESS_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        resolve(err ? null : stdout);
      },
    );
  });
}

async function readFromOs(): Promise<MdmSettings> {
  if (process.platform === "darwin") {
    let username = "";
    try {
      username = userInfo().username;
    } catch {
      /* userInfo が取れない環境ではデバイス全体の plist だけを見る */
    }
    for (const path of macOSPlistPaths(username)) {
      // plist が無い (MDM 非管理端末の大多数) なら plutil を起こさない。
      if (!existsSync(path)) continue;
      // 優先度順に 1 つずつ試し、 最初に読めたものを採用する (first source wins)。
      // oxlint-disable-next-line no-await-in-loop
      const stdout = await run(PLUTIL_PATH, ["-convert", "json", "-o", "-", "--", path]);
      const settings = stdout ? parseSettingsJson(stdout) : null;
      if (settings) return { admin: settings, hkcu: null };
    }
    return EMPTY;
  }
  if (process.platform === "win32") {
    const [hklm, hkcu] = await Promise.all([
      run("reg", ["query", REGISTRY_KEY_HKLM, "/v", REGISTRY_VALUE_NAME]),
      run("reg", ["query", REGISTRY_KEY_HKCU, "/v", REGISTRY_VALUE_NAME]),
    ]);
    const fromReg = (stdout: string | null): RawSettingsObject | null => {
      const json = stdout ? parseRegQueryStdout(stdout) : null;
      return json ? parseSettingsJson(json) : null;
    };
    return { admin: fromReg(hklm), hkcu: fromReg(hkcu) };
  }
  return EMPTY;
}

let reader: () => Promise<MdmSettings> = readFromOs;
let cache: { readonly at: number; readonly value: Promise<MdmSettings> } | null = null;

export function readMdmSettings(): Promise<MdmSettings> {
  const now = Date.now();
  if (cache === null || now - cache.at > CACHE_TTL_MS) {
    cache = { at: now, value: reader().catch(() => EMPTY) };
  }
  return cache.value;
}

/**
 * テスト用: OS 読み出しを差し替える (null で既定に戻す)。 開発機が実際に MDM
 * 管理下にあってもテスト結果がぶれないよう、 vitest の setup で空にしている。
 */
export function setMdmReaderForTests(next: (() => Promise<MdmSettings>) | null): void {
  reader = next ?? readFromOs;
  cache = null;
}
