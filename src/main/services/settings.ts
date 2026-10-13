import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";

import type { MemorySettings, ValueOrigin } from "@shared/schema/memory.ts";

import { type RawSettingsObject, readMdmSettings } from "./mdm.ts";

/**
 * Claude Code 公式実装 (src/memdir/paths.ts) と同じ precedence で
 * `autoMemoryEnabled` と `autoMemoryDirectory` を解決する。
 *
 * settings は file system から都度読む (UI 上で「現状の設定」を見るため)。
 *
 * 環境変数は「起動環境 + settings ファイルの `env` ブロック」で評価する。 公式は
 * 起動時に user → --settings → managed の順で `env` を process.env に書き込み
 * (src/utils/managedEnv.ts applySafeConfigEnvironmentVariables)、 シェルの値を
 * 上書きする (docs/env-vars.md "Precedence")。 `"env": {"CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1"}`
 * を settings.json に書いた人に「ON」と表示していた旧実装の不具合を直す。
 *
 * memlens は cwd を持たない desktop GUI なので、 公式が cwd 相対で読む
 * `projectSettings` (= <cwd>/.claude/settings.json) と `localSettings`
 * (= <cwd>/.claude/settings.local.json) は読まない。
 *
 * 参照:
 *   - src/memdir/paths.ts (isAutoMemoryEnabled, getAutoMemPath, getAutoMemPathSetting)
 *   - src/utils/envUtils.ts (isEnvTruthy / isEnvDefinedFalsy / getClaudeConfigHomeDir)
 *   - src/utils/managedEnv.ts (settings の env 適用順)
 *   - src/utils/settings/managedPath.ts (getManagedFilePath: Windows/macOS/Linux)
 *   - src/utils/settings/settings.ts:74 (loadManagedFileSettings: managed-settings.d/*.json)
 *   - src/utils/settings/mdm/* (MDM: macOS plist / Windows registry)
 *   - docs/settings-reference.md "Variables Claude Code ignores in env"
 *   - docs/managed-settings.md "How Claude Code combines managed sources"
 *   - docs/sessions.md "Name the project directory yourself"
 */

type RawSettings = RawSettingsObject;
type SettingsLayer = "policy" | "flag" | "user";
type EnvValue = { readonly value: string; readonly origin: ValueOrigin };

/**
 * settings ファイルの `env` では設定できず、 起動環境からしか読まれない変数。
 *   - CLAUDE_CODE_PROJECT_DIR_NAME: "is ignored from every file" (settings-reference)
 *   - CLAUDE_CODE_REMOTE: ホスティング環境が持つ identity 変数で "ignored from every file"
 *   - CLAUDE_CODE_SAFE_MODE: 設定を読む前に決まる (safe mode はカスタマイズ全体を
 *     読まないモードなので、 user settings 側から有効化はできない)
 */
const LAUNCH_ENV_ONLY: ReadonlySet<string> = new Set([
  "CLAUDE_CODE_PROJECT_DIR_NAME",
  "CLAUDE_CODE_REMOTE",
  "CLAUDE_CODE_SAFE_MODE",
]);

/** managed source の「policy key」に数えない制御用キー (managed-settings.md)。 */
const MANAGED_CONTROL_KEYS: ReadonlySet<string> = new Set([
  "wslInheritsWindowsSettings",
  "managedSourcesBehavior",
]);

/** 公式 isEnvTruthy (src/utils/envUtils.ts:32): '1' / 'true' / 'yes' / 'on'。 */
function isTruthyEnv(v: string | undefined): boolean {
  if (!v) return false;
  const norm = v.trim().toLowerCase();
  return norm === "1" || norm === "true" || norm === "yes" || norm === "on";
}

/**
 * 公式 isEnvDefinedFalsy (src/utils/envUtils.ts:39): '0' / 'false' / 'no' / 'off'。
 * 未定義 / 空文字は false (= 「明示的に false ではない」)。
 */
function isFalsyEnv(v: string | undefined): boolean {
  if (!v) return false;
  const norm = v.trim().toLowerCase();
  return norm === "0" || norm === "false" || norm === "no" || norm === "off";
}

function nonEmpty(v: string | undefined): string | null {
  return v !== undefined && v.trim().length > 0 ? v : null;
}

/** 起動環境の CLAUDE_CONFIG_DIR (user settings ファイルの場所を決める)。 */
function launchConfigDir(): string {
  // 公式 envUtils.ts:7 と同じく CLAUDE_CONFIG_DIR が最優先。 NFC 正規化も合わせる。
  // 公式は `??` 連結なので `CLAUDE_CONFIG_DIR=''` だと literal '' を返すが、
  // memlens は空文字を path として扱うと不具合になりかねないので unset 扱いにする。
  const override = nonEmpty(process.env["CLAUDE_CONFIG_DIR"]);
  return (override ?? join(homedir(), ".claude")).normalize("NFC");
}

/**
 * 公式 src/utils/settings/managedPath.ts と同じ platform 別 path。
 *
 * `CLAUDE_CODE_MANAGED_SETTINGS_PATH` override は公式では `USER_TYPE=ant` の
 * 内部ビルド限定だが、 memlens は admin / power user の自己責任 override として
 * USER_TYPE 制約なしで受け入れる (Windows ユーザが手動で managed-settings を
 * 配置するケースに対応するため)。
 */
function getManagedFilePath(): string {
  const override = nonEmpty(process.env["CLAUDE_CODE_MANAGED_SETTINGS_PATH"]);
  if (override) return override;
  if (process.platform === "win32") return "C:\\Program Files\\ClaudeCode";
  if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode";
  return "/etc/claude-code";
}

/**
 * `flag` 層: 公式の `flagSettings` は `--settings` CLI 引数で渡されるパスなので
 * env var ではない。 memlens は GUI なので memlens 固有の override として
 * CLAUDE_SETTINGS_PATH を受け入れる (test/debug 用途)。 通常は未設定で null。
 */
function flagSettingsPath(): string | null {
  return nonEmpty(process.env["CLAUDE_SETTINGS_PATH"]);
}

/**
 * settings ファイルを読む。 公式 safeParseJSON と同じく先頭 BOM を除いてから
 * JSON.parse する (PowerShell 5.x の `Out-File -Encoding utf8` は BOM を付けるので、
 * これが無いと Windows で書いた settings.json が丸ごと無視されていた)。
 */
async function readSettingsFile(path: string): Promise<RawSettings | null> {
  try {
    const raw = await fs.readFile(path, { encoding: "utf8" });
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as RawSettings;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * settings の `env` を文字列 map として取り出す。 公式の schema
 * (`z.record(z.string(), z.coerce.string())`) と同じく数値 / 真偽値は文字列化する。
 */
function envOf(settings: RawSettings | null): Record<string, string> {
  const env = settings?.["env"];
  if (!env || typeof env !== "object" || Array.isArray(env)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") out[key] = String(value);
  }
  return out;
}

/**
 * 公式 loadManagedFileSettings (src/utils/settings/settings.ts:74) と同じ仕様で
 * `managed-settings.json` を base に、 `managed-settings.d/*.json` を
 * alphabetical 順で上書き merge する。 memlens が読むキーは scalar の
 * `autoMemoryEnabled` / string の `autoMemoryDirectory` と、 変数単位で
 * 上書きする `env` なので、 env 以外は shallow merge で十分。
 */
async function loadManagedFileSettings(): Promise<RawSettings | null> {
  const managedDir = getManagedFilePath();
  const base = await readSettingsFile(join(managedDir, "managed-settings.json"));
  let merged: Record<string, unknown> = base ? { ...base } : {};
  let found = base !== null && Object.keys(base).length > 0;

  const dropInDir = join(managedDir, "managed-settings.d");
  let dropInNames: string[];
  try {
    const entries = await fs.readdir(dropInDir, { withFileTypes: true });
    dropInNames = entries
      .filter(
        (d) =>
          (d.isFile() || d.isSymbolicLink()) && d.name.endsWith(".json") && !d.name.startsWith("."),
      )
      .map((d) => d.name)
      .sort();
  } catch {
    dropInNames = [];
  }
  const overlays = await Promise.all(
    dropInNames.map((name) => readSettingsFile(join(dropInDir, name))),
  );
  for (const overlay of overlays) {
    if (overlay && Object.keys(overlay).length > 0) {
      const env = { ...envOf(merged), ...envOf(overlay) };
      merged = { ...merged, ...overlay };
      // 空の env を足すと「policy key を持つソース」に化けて下位 (HKCU) を隠すので、
      // 実際に変数があるときだけ置く。
      if (Object.keys(env).length > 0) merged["env"] = env;
      found = true;
    }
  }
  return found ? (merged as RawSettings) : null;
}

function hasPolicyKey(settings: RawSettings | null): settings is RawSettings {
  return settings !== null && Object.keys(settings).some((key) => !MANAGED_CONTROL_KEYS.has(key));
}

export type PolicyLayer = {
  readonly settings: RawSettings | null;
  readonly env: Record<string, string>;
  readonly source: MemorySettings["policySource"];
};

/**
 * managed 層を docs/managed-settings.md の規則で 1 つにまとめる。
 *
 *   - ソースの順位: MDM (macOS plist / HKLM) → managed settings ファイル → HKCU
 *     (remote = server-managed settings は端末から見えないので対象外)
 *   - 既定 ("first-wins"): policy key を持つ最上位のソースだけを使う。
 *     `managedSourcesBehavior: "merge"` なら管理者ソースを上位優先で合成する。
 *     このキーは「キー自体か policy key を持つ最上位の管理者ソース」からだけ読む
 *     (下位のソースが自分から merge に加わることはできない)
 *   - `env` は変数ごとに管理者ソース全体から上位優先で集める (v2.1.223+)
 *   - HKCU はユーザが書けるので、 管理者ソースが 1 つも無いときだけ使う
 */
export function selectPolicyLayer(sources: {
  readonly mdm: RawSettings | null;
  readonly file: RawSettings | null;
  readonly hkcu: RawSettings | null;
}): PolicyLayer {
  const admins: Array<{ settings: RawSettings; source: "mdm" | "file" }> = [];
  if (hasPolicyKey(sources.mdm)) admins.push({ settings: sources.mdm, source: "mdm" });
  if (hasPolicyKey(sources.file)) admins.push({ settings: sources.file, source: "file" });
  const top = admins[0];
  if (top === undefined) {
    if (hasPolicyKey(sources.hkcu)) {
      return { settings: sources.hkcu, env: envOf(sources.hkcu), source: "hkcu" };
    }
    return { settings: null, env: {}, source: null };
  }
  // 下位 → 上位の順に重ねれば上位が勝つ。
  const lowFirst = [...admins].reverse();
  const env: Record<string, string> = {};
  for (const admin of lowFirst) Object.assign(env, envOf(admin.settings));
  const deciding = [sources.mdm, sources.file].find(
    (s) => s !== null && (hasPolicyKey(s) || "managedSourcesBehavior" in s),
  );
  const merge = deciding?.["managedSourcesBehavior"] === "merge";
  let settings: RawSettings = top.settings;
  if (merge) {
    const combined: Record<string, unknown> = {};
    for (const admin of lowFirst) Object.assign(combined, admin.settings);
    settings = combined;
  }
  return { settings, env, source: top.source };
}

async function loadPolicyLayer(): Promise<PolicyLayer> {
  const [file, mdm] = await Promise.all([loadManagedFileSettings(), readMdmSettings()]);
  return selectPolicyLayer({ mdm: mdm.admin, file, hkcu: mdm.hkcu });
}

/**
 * 公式 validateMemoryPath (src/memdir/paths.ts:109) と同じ rule:
 *   - ~/ 展開 (expandTilde=true のときのみ)
 *   - bare ~ / ~/. / ~/.. は reject
 *   - 非絶対 / length<3 / Windows drive root / UNC / null byte は reject
 *   - 末尾を sep に揃え、NFC 正規化
 */
function validateMemoryPath(raw: unknown, expandTilde: boolean): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let candidate = raw;
  if (expandTilde && (candidate.startsWith("~/") || candidate.startsWith("~\\"))) {
    const rest = candidate.slice(2);
    const restNorm = normalize(rest.length === 0 ? "." : rest);
    if (restNorm === "." || restNorm === "..") return null;
    candidate = join(homedir(), rest);
  }
  const normalized = normalize(candidate).replace(/[/\\]+$/, "");
  if (
    !isAbsolute(normalized) ||
    normalized.length < 3 ||
    /^[A-Za-z]:$/.test(normalized) ||
    normalized.startsWith("\\\\") ||
    normalized.startsWith("//") ||
    normalized.includes("\0")
  ) {
    return null;
  }
  return (normalized + sep).normalize("NFC");
}

/** Windows の予約デバイス名 (docs/sessions.md: "don't use a Windows device name such as con")。 */
const WINDOWS_DEVICE_NAME_RE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * CLAUDE_CODE_PROJECT_DIR_NAME (v2.1.234+) の検証。 docs/sessions.md:
 *   - CLAUDE_CONFIG_DIR が設定されていないと無視される
 *   - 1-64 文字の英数字 / `-` / `_` のみ。 それ以外は無視して通常の名前を使う
 *   - 起動環境からのみ読む (settings の env では設定できない)
 */
export function validateProjectDirName(
  name: string | undefined,
  configDirSet: boolean,
): string | null {
  if (!configDirSet || name === undefined) return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) return null;
  if (WINDOWS_DEVICE_NAME_RE.test(name)) return null;
  return name;
}

export async function resolveMemorySettings(): Promise<MemorySettings> {
  // 全レイヤを並列で読み込み、 precedence 順に走査する (loop 内で await しない)。
  const flagPath = flagSettingsPath();
  const [policy, flagData, userData] = await Promise.all([
    loadPolicyLayer(),
    flagPath ? readSettingsFile(flagPath) : Promise.resolve(null),
    readSettingsFile(join(launchConfigDir(), "settings.json")),
  ]);
  const layered: ReadonlyArray<{ source: SettingsLayer; data: RawSettings | null }> = [
    { source: "policy", data: policy.settings },
    { source: "flag", data: flagData },
    { source: "user", data: userData },
  ];

  // settings の env は user → flag → policy の順に書き込まれる (後勝ち) ので、
  // 引くときは policy から見ていき、 どこにも無ければ起動環境を見る。
  const settingsEnv: ReadonlyArray<{ origin: ValueOrigin; env: Record<string, string> }> = [
    { origin: "policy", env: policy.env },
    { origin: "flag", env: envOf(flagData) },
    { origin: "user", env: envOf(userData) },
  ];
  const getEnv = (name: string): EnvValue | null => {
    if (!LAUNCH_ENV_ONLY.has(name)) {
      for (const { origin, env } of settingsEnv) {
        const value = env[name];
        if (value !== undefined) return { value, origin };
      }
    }
    const value = process.env[name];
    return value === undefined ? null : { value, origin: "shell" };
  };

  // CLAUDE_CONFIG_DIR は shell / user settings / managed settings で設定できる
  // (docs/env-vars.md)。 user settings ファイル自体は起動環境の場所から読む。
  const configDirOverride = nonEmpty(getEnv("CLAUDE_CONFIG_DIR")?.value);
  const configDir = (configDirOverride ?? join(homedir(), ".claude")).normalize("NFC");
  const remoteMemoryDir =
    nonEmpty(getEnv("CLAUDE_CODE_REMOTE_MEMORY_DIR")?.value)?.normalize("NFC") ?? null;
  const baseDir = remoteMemoryDir ?? configDir;

  // ── enabled 解決 (公式 isAutoMemoryEnabled の順序 + safe mode) ──────────
  // 0. CLAUDE_CODE_SAFE_MODE truthy → OFF (docs/env-vars.md: safe mode では auto
  //    memory を読まない。 DISABLE_AUTO_MEMORY=0 で強制 ON できるのは --bare と
  //    autoMemoryEnabled: false だけと明記されている)
  // 1. CLAUDE_CODE_DISABLE_AUTO_MEMORY truthy → OFF / falsy → ON (forced)
  // 2. CLAUDE_CODE_SIMPLE truthy → OFF
  // 3. CLAUDE_CODE_REMOTE && !CLAUDE_CODE_REMOTE_MEMORY_DIR → OFF
  // 4. settings.autoMemoryEnabled (boolean) → その値
  // 5. default → ON
  let enabled = true;
  let enabledSource: MemorySettings["enabledSource"] = "default";
  let enabledOrigin: ValueOrigin | null = null;

  const safeMode = getEnv("CLAUDE_CODE_SAFE_MODE");
  const disable = getEnv("CLAUDE_CODE_DISABLE_AUTO_MEMORY");
  const simple = getEnv("CLAUDE_CODE_SIMPLE");
  const remote = getEnv("CLAUDE_CODE_REMOTE");
  if (safeMode && isTruthyEnv(safeMode.value)) {
    enabled = false;
    enabledSource = "env-safe-mode";
    enabledOrigin = safeMode.origin;
  } else if (disable && isTruthyEnv(disable.value)) {
    enabled = false;
    enabledSource = "env-disable";
    enabledOrigin = disable.origin;
  } else if (disable && isFalsyEnv(disable.value)) {
    enabled = true;
    enabledSource = "env-disable";
    enabledOrigin = disable.origin;
  } else if (simple && isTruthyEnv(simple.value)) {
    enabled = false;
    enabledSource = "env-simple";
    enabledOrigin = simple.origin;
  } else if (remote && isTruthyEnv(remote.value) && remoteMemoryDir === null) {
    enabled = false;
    enabledSource = "env-remote";
    enabledOrigin = remote.origin;
  } else {
    const enabledHit = layered.find((l) => typeof l.data?.["autoMemoryEnabled"] === "boolean");
    if (enabledHit?.data) {
      enabled = enabledHit.data["autoMemoryEnabled"] as boolean;
      enabledSource = "settings";
      enabledOrigin = enabledHit.source;
    }
  }

  // ── autoMemoryDirectory 解決 ──────────────────────────────
  // 公式優先順 (src/memdir/paths.ts:223):
  //   1. CLAUDE_COWORK_MEMORY_PATH_OVERRIDE (env, expandTilde=false)
  //   2. settings.autoMemoryDirectory (policy → flag → local → user)
  //
  // (2) は公式 getAutoMemPathSetting (src/memdir/paths.ts:179) と同じく「最初に
  // 値が定義されている層」を選んでから 1 回だけ validate する。 上位層の値が
  // invalid でも下位層へはフォールバックしない (公式は `??` 連結後に validate
  // するため、 その状況では directory 未設定 = デフォルト path になる)。
  // 非 string 値の層は公式の zod validation で層ごと捨てられるので飛ばす。
  let autoMemoryDirectory: string | null = null;
  let autoMemoryDirectorySource: MemorySettings["autoMemoryDirectorySource"] = null;
  let autoMemoryDirectoryOrigin: ValueOrigin | null = null;

  const cowork = getEnv("CLAUDE_COWORK_MEMORY_PATH_OVERRIDE");
  const coworkOverride = validateMemoryPath(cowork?.value, false);
  if (cowork && coworkOverride !== null) {
    autoMemoryDirectory = coworkOverride;
    autoMemoryDirectorySource = "cowork";
    autoMemoryDirectoryOrigin = cowork.origin;
  } else {
    const defined = layered.find((l) => typeof l.data?.["autoMemoryDirectory"] === "string");
    if (defined?.data) {
      const v = validateMemoryPath(defined.data["autoMemoryDirectory"], true);
      if (v !== null) {
        autoMemoryDirectory = v;
        autoMemoryDirectorySource = defined.source;
      }
    }
  }

  return {
    enabled,
    enabledSource,
    enabledOrigin,
    autoMemoryDirectory,
    autoMemoryDirectorySource,
    autoMemoryDirectoryOrigin,
    configDir,
    baseDir,
    remoteMemoryDir,
    projectDirName: validateProjectDirName(
      process.env["CLAUDE_CODE_PROJECT_DIR_NAME"],
      configDirOverride !== null,
    ),
    policySource: policy.source,
    homedir: homedir(),
  };
}
