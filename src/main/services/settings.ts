import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";

import type { MemorySettings } from "@shared/schema/memory.ts";

/**
 * Claude Code 公式実装 (src/memdir/paths.ts) と同じ precedence で
 * `autoMemoryEnabled` と `autoMemoryDirectory` を解決する。
 *
 * env 周りはプロセス起動時に固定されているが、 settings は file system から
 * 都度読む (UI 上で「現状の設定」を見るためそのほうが正確)。
 *
 * memlens は cwd を持たない desktop GUI なので、 公式が cwd 相対で読む
 * `projectSettings` (= <cwd>/.claude/settings.json) と `localSettings`
 * (= <cwd>/.claude/settings.local.json) は読まない。 これらを読みたい場合は
 * `/memory` 相当の「プロジェクトを選んだ後にその cwd の local も含めて
 * 再 resolve」する API を別途出す必要がある (今後の TODO)。
 *
 * 参照:
 *   - src/memdir/paths.ts (isAutoMemoryEnabled, getAutoMemPath, getAutoMemPathSetting)
 *   - src/memdir/paths.ts:161 (getAutoMemPathOverride: CLAUDE_COWORK_MEMORY_PATH_OVERRIDE)
 *   - src/utils/envUtils.ts (isEnvTruthy / isEnvDefinedFalsy / getClaudeConfigHomeDir)
 *   - src/utils/settings/managedPath.ts (getManagedFilePath: Windows/macOS/Linux)
 *   - src/utils/settings/settings.ts:74 (loadManagedFileSettings: managed-settings.d/*.json drop-ins)
 */

type RawSettings = {
  readonly autoMemoryEnabled?: unknown;
  readonly autoMemoryDirectory?: unknown;
};

const SETTINGS_SOURCES = ["policy", "flag", "user"] as const;
type SettingsSource = (typeof SETTINGS_SOURCES)[number];

/**
 * 公式 isEnvTruthy (src/utils/envUtils.ts:32): '1' / 'true' / 'yes' / 'on'。
 */
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
  if (v === undefined) return false;
  const norm = v.trim().toLowerCase();
  return norm === "0" || norm === "false" || norm === "no" || norm === "off";
}

function getClaudeConfigHomeDir(): string {
  // 公式 envUtils.ts:7 と同じく `CLAUDE_CONFIG_DIR` が最優先。 NFC 正規化も合わせる。
  // 公式は `??` 連結なので `CLAUDE_CONFIG_DIR=''` だと literal '' を返す。
  // memlens は空文字を path として扱うと不具合になりかねないので defensive に
  // unset と同じ扱いにし、 デフォルトの `~/.claude` を返す。
  const override = process.env["CLAUDE_CONFIG_DIR"];
  if (override && override.trim().length > 0) {
    return override.normalize("NFC");
  }
  return join(homedir(), ".claude").normalize("NFC");
}

function getMemoryBaseDir(): string {
  const override = process.env["CLAUDE_CODE_REMOTE_MEMORY_DIR"];
  if (override && override.trim().length > 0) {
    return override.normalize("NFC");
  }
  return getClaudeConfigHomeDir();
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
  const override = process.env["CLAUDE_CODE_MANAGED_SETTINGS_PATH"];
  if (override && override.trim().length > 0) {
    return override;
  }
  if (process.platform === "win32") {
    return "C:\\Program Files\\ClaudeCode";
  }
  if (process.platform === "darwin") {
    return "/Library/Application Support/ClaudeCode";
  }
  return "/etc/claude-code";
}

/**
 * `flag` 層: 公式の `flagSettings` は `--settings` CLI 引数で渡されるパスを
 * bootstrap state 経由で受け取るので env var ではない。 memlens は GUI なので
 * memlens 固有の override として CLAUDE_SETTINGS_PATH を受け入れる (test/debug
 * 用途)。 通常運用ではこの環境変数は未設定で `null` が返る。
 *
 * `policy` 層: managed-settings.json (base) は drop-in と merge する都合上、
 * settingsPathFor 経由ではなく loadManagedSettings 側で読む。
 */
function settingsPathFor(source: SettingsSource): string | null {
  const home = getClaudeConfigHomeDir();
  if (source === "policy") {
    return join(getManagedFilePath(), "managed-settings.json");
  }
  if (source === "flag") {
    const flag = process.env["CLAUDE_SETTINGS_PATH"];
    return flag && flag.trim().length > 0 ? flag : null;
  }
  // source === "user"
  return join(home, "settings.json");
}

async function readSettingsFile(path: string): Promise<RawSettings | null> {
  try {
    const raw = await fs.readFile(path, { encoding: "utf8" });
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as RawSettings;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 公式 loadManagedFileSettings (src/utils/settings/settings.ts:74) と同じ仕様で
 * `managed-settings.json` を base に、 `managed-settings.d/*.json` を
 * alphabetical 順で上書き merge する。 ここでは shallow merge で十分
 * (memlens が読むキーは scalar の `autoMemoryEnabled` と string の
 * `autoMemoryDirectory` だけなので、 公式 settingsMergeCustomizer の特殊扱いは
 * 不要)。
 */
async function loadManagedSettings(): Promise<RawSettings | null> {
  const base = await readSettingsFile(join(getManagedFilePath(), "managed-settings.json"));
  let merged: Record<string, unknown> = base ? { ...base } : {};
  let found = base !== null;

  const dropInDir = join(getManagedFilePath(), "managed-settings.d");
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
      merged = { ...merged, ...overlay };
      found = true;
    }
  }
  return found ? (merged as RawSettings) : null;
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

export async function resolveMemorySettings(): Promise<MemorySettings> {
  const baseDir = getMemoryBaseDir();
  const remoteMemoryDir = process.env["CLAUDE_CODE_REMOTE_MEMORY_DIR"] ?? null;

  // 全レイヤを並列で読み込み、 precedence 順に走査する (loop 内で await しない)。
  // policy は drop-in merge が要るので専用 loader を使う。 flag/user は素朴 read。
  const [policyData, flagUserLayers] = await Promise.all([
    loadManagedSettings(),
    Promise.all(
      (["flag", "user"] as const).map(async (source) => {
        const path = settingsPathFor(source);
        if (!path) return { source, data: null as RawSettings | null };
        const data = await readSettingsFile(path);
        return { source, data };
      }),
    ),
  ]);
  const layered: ReadonlyArray<{
    source: SettingsSource;
    data: RawSettings | null;
  }> = [{ source: "policy", data: policyData }, ...flagUserLayers];

  // ── enabled 解決 (公式 isAutoMemoryEnabled の順序) ──────────
  // 1. CLAUDE_CODE_DISABLE_AUTO_MEMORY truthy → OFF / falsy → ON (forced)
  // 2. CLAUDE_CODE_SIMPLE truthy → OFF
  // 3. CLAUDE_CODE_REMOTE && !CLAUDE_CODE_REMOTE_MEMORY_DIR → OFF
  // 4. settings.autoMemoryEnabled (boolean) → その値
  // 5. default → ON
  let enabled = true;
  let enabledSource: MemorySettings["enabledSource"] = "default";

  const disableEnv = process.env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"];
  if (isTruthyEnv(disableEnv)) {
    enabled = false;
    enabledSource = "env-disable";
  } else if (isFalsyEnv(disableEnv)) {
    enabled = true;
    enabledSource = "env-disable";
  } else if (isTruthyEnv(process.env["CLAUDE_CODE_SIMPLE"])) {
    enabled = false;
    enabledSource = "env-simple";
  } else if (isTruthyEnv(process.env["CLAUDE_CODE_REMOTE"]) && !remoteMemoryDir) {
    enabled = false;
    enabledSource = "env-remote";
  } else {
    const enabledHit = layered.find((l) => l.data && typeof l.data.autoMemoryEnabled === "boolean");
    if (enabledHit?.data) {
      enabled = enabledHit.data.autoMemoryEnabled as boolean;
      enabledSource = "settings";
    }
  }

  // ── autoMemoryDirectory 解決 ──────────────────────────────
  // 公式優先順 (src/memdir/paths.ts:223):
  //   1. CLAUDE_COWORK_MEMORY_PATH_OVERRIDE (env, expandTilde=false)
  //   2. settings.autoMemoryDirectory (policy → flag → local → user)
  //
  // memlens は (1) を `cowork` source として扱う。 (2) は公式
  // getAutoMemPathSetting (src/memdir/paths.ts:179) と同じく「最初に値が定義
  // されている層」を選んでから 1 回だけ validate する。 上位層の値が invalid
  // でも下位層へはフォールバックしない (公式は `??` 連結後に validate する
  // ため、 その状況では directory 未設定 = デフォルト path になる)。
  // local は GUI に cwd の概念が無いため対象外。
  let autoMemoryDirectory: string | null = null;
  let autoMemoryDirectorySource: MemorySettings["autoMemoryDirectorySource"] = null;

  const coworkOverride = validateMemoryPath(
    process.env["CLAUDE_COWORK_MEMORY_PATH_OVERRIDE"],
    false,
  );
  if (coworkOverride !== null) {
    autoMemoryDirectory = coworkOverride;
    autoMemoryDirectorySource = "cowork";
  } else {
    // 「値が定義されている」= string 値に限る。 公式では非 string 値
    // (数値や object) は settings ファイル全体が zod validation
    // (autoMemoryDirectory: z.string().optional(), src/utils/settings/types.ts)
    // で reject され (parseSettingsFile → settings: null)、 その層は `??` 連結に
    // 何も供給しない = 下位層へフォールバックする。 typeof チェックはその
    // per-key 近似であり、 非 string 値の層をスキップして下位層を見るのは
    // 公式と同じ結論になる。
    const defined = layered.find(
      (l) => l.data !== null && typeof l.data.autoMemoryDirectory === "string",
    );
    if (defined?.data) {
      const v = validateMemoryPath(defined.data.autoMemoryDirectory, true);
      if (v !== null) {
        autoMemoryDirectory = v;
        autoMemoryDirectorySource = defined.source;
      }
    }
  }

  return {
    enabled,
    enabledSource,
    autoMemoryDirectory,
    autoMemoryDirectorySource,
    baseDir,
    remoteMemoryDir,
    homedir: homedir(),
  };
}
