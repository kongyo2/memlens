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
 */

type RawSettings = {
  readonly autoMemoryEnabled?: unknown;
  readonly autoMemoryDirectory?: unknown;
};

const SETTINGS_SOURCES = ["policy", "flag", "local", "user"] as const;
type SettingsSource = (typeof SETTINGS_SOURCES)[number];

function isTruthyEnv(v: string | undefined): boolean {
  if (!v) return false;
  const norm = v.trim().toLowerCase();
  return norm === "1" || norm === "true" || norm === "yes";
}

function isFalsyEnv(v: string | undefined): boolean {
  if (v === undefined) return false;
  const norm = v.trim().toLowerCase();
  return norm === "0" || norm === "false" || norm === "no";
}

function getClaudeConfigHomeDir(): string {
  // 公式 (envUtils.ts) と同じく `CLAUDE_CONFIG_DIR` が最優先。
  const override = process.env["CLAUDE_CONFIG_DIR"];
  if (override && override.trim().length > 0) {
    return override;
  }
  return join(homedir(), ".claude");
}

function getMemoryBaseDir(): string {
  const override = process.env["CLAUDE_CODE_REMOTE_MEMORY_DIR"];
  if (override && override.trim().length > 0) {
    return override;
  }
  return getClaudeConfigHomeDir();
}

function settingsPathFor(source: SettingsSource): string | null {
  const home = getClaudeConfigHomeDir();
  switch (source) {
    case "policy": {
      const env = process.env["CLAUDE_CODE_MANAGED_SETTINGS_PATH"];
      if (env && env.trim().length > 0) return env;
      if (process.platform === "win32") {
        return "C:\\ProgramData\\ClaudeCode\\managed-settings.json";
      }
      if (process.platform === "darwin") {
        return "/Library/Application Support/ClaudeCode/managed-settings.json";
      }
      return "/etc/claude-code/managed-settings.json";
    }
    case "flag": {
      const flag = process.env["CLAUDE_SETTINGS_PATH"];
      return flag && flag.trim().length > 0 ? flag : null;
    }
    case "local":
      return join(home, "settings.local.json");
    case "user":
      return join(home, "settings.json");
  }
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
 * 公式 validateMemoryPath (src/memdir/paths.ts:109) と同じ rule:
 *   - ~/ 展開 (expandTilde=true のときのみ)
 *   - bare ~ / ~/. / ~/.. は reject
 *   - 非絶対 / length<3 / Windows drive root / UNC / null byte は reject
 *   - 末尾を sep に揃え、NFC 正規化
 */
function validateMemoryPath(raw: unknown, expandTilde: boolean): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let candidate = raw;
  if (
    expandTilde &&
    (candidate.startsWith("~/") || candidate.startsWith("~\\"))
  ) {
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
  const layered = await Promise.all(
    SETTINGS_SOURCES.map(async (source) => {
      const path = settingsPathFor(source);
      if (!path) return { source, data: null as RawSettings | null };
      const data = await readSettingsFile(path);
      return { source, data };
    }),
  );

  // ── enabled 解決 (公式 isAutoMemoryEnabled の順序) ──────────
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
  } else if (
    isTruthyEnv(process.env["CLAUDE_CODE_REMOTE"]) &&
    !remoteMemoryDir
  ) {
    enabled = false;
    enabledSource = "env-remote";
  } else {
    const enabledHit = layered.find(
      (l) => l.data && typeof l.data.autoMemoryEnabled === "boolean",
    );
    if (enabledHit?.data) {
      enabled = enabledHit.data.autoMemoryEnabled as boolean;
      enabledSource = "settings";
    }
  }

  // ── autoMemoryDirectory 解決 (公式 getAutoMemPathSetting) ──
  let autoMemoryDirectory: string | null = null;
  let autoMemoryDirectorySource: MemorySettings["autoMemoryDirectorySource"] =
    null;
  for (const { source, data } of layered) {
    if (!data) continue;
    const v = validateMemoryPath(data.autoMemoryDirectory, true);
    if (v !== null) {
      autoMemoryDirectory = v;
      autoMemoryDirectorySource = source;
      break;
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
