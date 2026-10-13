import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MdmSettings } from "../mdm.ts";

const ENV_KEYS = [
  "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
  "CLAUDE_CODE_SIMPLE",
  "CLAUDE_CODE_SAFE_MODE",
  "CLAUDE_CODE_REMOTE",
  "CLAUDE_CODE_REMOTE_MEMORY_DIR",
  "CLAUDE_CODE_PROJECT_DIR_NAME",
  "CLAUDE_SETTINGS_PATH",
  "CLAUDE_CODE_MANAGED_SETTINGS_PATH",
  "CLAUDE_COWORK_MEMORY_PATH_OVERRIDE",
  "CLAUDE_CONFIG_DIR",
] as const;

const NONEXISTENT = "/__memlens_test_nonexistent__";
const NO_MDM: MdmSettings = { admin: null, hkcu: null };

function clearEnv(): void {
  for (const k of ENV_KEYS) {
    delete process.env[k];
  }
}

/**
 * settings.ts を新しい module instance として読み込み、 MDM の OS 読み出しを
 * 差し替える (開発機が実際に MDM 管理下でも結果がぶれないように)。
 */
async function load(mdm: MdmSettings = NO_MDM): Promise<typeof import("../settings.ts")> {
  const mdmModule = await import("../mdm.ts");
  mdmModule.setMdmReaderForTests(async () => mdm);
  return import("../settings.ts");
}

/** managed dir を存在しない場所に向け、 端末の managed-settings.json を読まない。 */
function isolateManaged(): void {
  process.env["CLAUDE_CODE_MANAGED_SETTINGS_PATH"] = NONEXISTENT;
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("resolveMemorySettings", () => {
  const cleanup: string[] = [];

  beforeEach(() => {
    clearEnv();
    vi.resetModules();
  });

  afterEach(async () => {
    clearEnv();
    vi.restoreAllMocks();
    await Promise.all(cleanup.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function homeWithSettings(settings: unknown, raw?: string): Promise<string> {
    const home = await tempDir("memlens-home-");
    cleanup.push(home);
    await writeFile(join(home, "settings.json"), raw ?? JSON.stringify(settings), "utf8");
    return home;
  }

  it("returns enabled=true with default source when nothing is configured", async () => {
    const { resolveMemorySettings } = await load();
    // settings.json も無いことを保証するため CLAUDE_CONFIG_DIR を /nonexistent に。
    process.env["CLAUDE_CONFIG_DIR"] = NONEXISTENT;
    isolateManaged();
    const s = await resolveMemorySettings();
    expect(s.enabled).toBe(true);
    expect(s.enabledSource).toBe("default");
    expect(s.enabledOrigin).toBeNull();
    expect(s.autoMemoryDirectory).toBeNull();
    expect(s.policySource).toBeNull();
  });

  it("respects CLAUDE_CODE_DISABLE_AUTO_MEMORY truthy", async () => {
    const { resolveMemorySettings } = await load();
    process.env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "1";
    process.env["CLAUDE_CONFIG_DIR"] = NONEXISTENT;
    const s = await resolveMemorySettings();
    expect(s.enabled).toBe(false);
    expect(s.enabledSource).toBe("env-disable");
    expect(s.enabledOrigin).toBe("shell");
  });

  it("respects CLAUDE_CODE_DISABLE_AUTO_MEMORY explicit false (forces ON)", async () => {
    const { resolveMemorySettings } = await load();
    process.env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "0";
    process.env["CLAUDE_CONFIG_DIR"] = NONEXISTENT;
    const s = await resolveMemorySettings();
    expect(s.enabled).toBe(true);
    expect(s.enabledSource).toBe("env-disable");
  });

  it("respects CLAUDE_CODE_SIMPLE → OFF", async () => {
    const { resolveMemorySettings } = await load();
    process.env["CLAUDE_CODE_SIMPLE"] = "true";
    process.env["CLAUDE_CONFIG_DIR"] = NONEXISTENT;
    const s = await resolveMemorySettings();
    expect(s.enabled).toBe(false);
    expect(s.enabledSource).toBe("env-simple");
  });

  it("respects CLAUDE_CODE_SAFE_MODE → OFF even when DISABLE_AUTO_MEMORY=0 forces ON", async () => {
    // docs/env-vars.md: safe mode では auto memory を読まない。 DISABLE_AUTO_MEMORY=0
    // が上書きできるのは --bare と autoMemoryEnabled: false だけ。
    const { resolveMemorySettings } = await load();
    process.env["CLAUDE_CODE_SAFE_MODE"] = "1";
    process.env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "0";
    process.env["CLAUDE_CONFIG_DIR"] = NONEXISTENT;
    const s = await resolveMemorySettings();
    expect(s.enabled).toBe(false);
    expect(s.enabledSource).toBe("env-safe-mode");
  });

  it("respects CLAUDE_CODE_REMOTE without REMOTE_MEMORY_DIR → OFF", async () => {
    const { resolveMemorySettings } = await load();
    process.env["CLAUDE_CODE_REMOTE"] = "1";
    process.env["CLAUDE_CONFIG_DIR"] = NONEXISTENT;
    const s = await resolveMemorySettings();
    expect(s.enabled).toBe(false);
    expect(s.enabledSource).toBe("env-remote");
  });

  it("uses REMOTE_MEMORY_DIR as baseDir override", async () => {
    const { resolveMemorySettings } = await load();
    process.env["CLAUDE_CODE_REMOTE_MEMORY_DIR"] = "/tmp/remote-memory";
    process.env["CLAUDE_CONFIG_DIR"] = NONEXISTENT;
    const s = await resolveMemorySettings();
    expect(s.baseDir).toBe("/tmp/remote-memory");
    expect(s.remoteMemoryDir).toBe("/tmp/remote-memory");
    expect(s.configDir).toBe(NONEXISTENT);
  });

  it("accepts on/off as truthy/falsy env values (parity with official isEnvTruthy)", async () => {
    const { resolveMemorySettings } = await load();
    process.env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "on";
    process.env["CLAUDE_CONFIG_DIR"] = NONEXISTENT;
    let s = await resolveMemorySettings();
    expect(s.enabled).toBe(false);
    expect(s.enabledSource).toBe("env-disable");

    process.env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "OFF";
    s = await resolveMemorySettings();
    expect(s.enabled).toBe(true);
    expect(s.enabledSource).toBe("env-disable");
  });

  it("honors CLAUDE_COWORK_MEMORY_PATH_OVERRIDE as highest-priority directory override", async () => {
    const { resolveMemorySettings } = await load();
    process.env["CLAUDE_CONFIG_DIR"] = NONEXISTENT;
    // 公式 validateMemoryPath は expandTilde=false で env を受け、 絶対 path のみ。
    process.env["CLAUDE_COWORK_MEMORY_PATH_OVERRIDE"] = "/tmp/cowork-mem";
    const s = await resolveMemorySettings();
    // validateMemoryPath は node:path normalize を通すため、 Windows では
    // separator が `\` に変わる ('/tmp/cowork-mem' → '\tmp\cowork-mem\')。
    expect(s.autoMemoryDirectory).toMatch(/^[/\\]tmp[/\\]cowork-mem[/\\]?$/);
    expect(s.autoMemoryDirectorySource).toBe("cowork");
    expect(s.autoMemoryDirectoryOrigin).toBe("shell");
  });

  it("rejects bare tilde / non-absolute CLAUDE_COWORK_MEMORY_PATH_OVERRIDE silently", async () => {
    const { resolveMemorySettings } = await load();
    process.env["CLAUDE_CONFIG_DIR"] = NONEXISTENT;
    process.env["CLAUDE_COWORK_MEMORY_PATH_OVERRIDE"] = "~/cowork-mem";
    const s = await resolveMemorySettings();
    // env で tilde 展開は不許可 (公式 paths.ts:122 と一致)。
    expect(s.autoMemoryDirectory).toBeNull();
  });

  it("uses the first *defined* autoMemoryDirectory layer and does NOT fall through when it is invalid (official parity)", async () => {
    // 公式 getAutoMemPathSetting (src/memdir/paths.ts:179) は
    // `policy ?? flag ?? local ?? user` で値を選んでから 1 回だけ validate する。
    // つまり上位層の invalid な値は下位層の valid な値で救済されない。
    const managedDir = await tempDir("memlens-managed-");
    cleanup.push(managedDir);
    await writeFile(
      join(managedDir, "managed-settings.json"),
      JSON.stringify({ autoMemoryDirectory: "relative/not-allowed" }),
      "utf8",
    );
    const home = await homeWithSettings({ autoMemoryDirectory: join(tmpdir(), "user-mem") });
    process.env["CLAUDE_CODE_MANAGED_SETTINGS_PATH"] = managedDir;
    process.env["CLAUDE_CONFIG_DIR"] = home;
    const { resolveMemorySettings } = await load();
    const s = await resolveMemorySettings();
    expect(s.autoMemoryDirectory).toBeNull();
    expect(s.autoMemoryDirectorySource).toBeNull();
    expect(s.policySource).toBe("file");
  });

  it("falls through when a higher layer's autoMemoryDirectory is a non-string (official rejects the whole file via zod)", async () => {
    const managedDir = await tempDir("memlens-managed-");
    cleanup.push(managedDir);
    await writeFile(
      join(managedDir, "managed-settings.json"),
      JSON.stringify({ autoMemoryDirectory: 123 }),
      "utf8",
    );
    const home = await homeWithSettings({ autoMemoryDirectory: join(tmpdir(), "user-mem-2") });
    process.env["CLAUDE_CODE_MANAGED_SETTINGS_PATH"] = managedDir;
    process.env["CLAUDE_CONFIG_DIR"] = home;
    const { resolveMemorySettings } = await load();
    const s = await resolveMemorySettings();
    expect(s.autoMemoryDirectorySource).toBe("user");
    expect(s.autoMemoryDirectory).toContain("user-mem-2");
  });

  it("honors a valid user-layer autoMemoryDirectory when higher layers are silent", async () => {
    const target = join(tmpdir(), "memlens-user-mem");
    const home = await homeWithSettings({ autoMemoryDirectory: target });
    process.env["CLAUDE_CONFIG_DIR"] = home;
    isolateManaged();
    const { resolveMemorySettings } = await load();
    const s = await resolveMemorySettings();
    expect(s.autoMemoryDirectorySource).toBe("user");
    expect(s.autoMemoryDirectory).not.toBeNull();
    expect(s.autoMemoryDirectory).toContain("memlens-user-mem");
  });

  it("merges managed-settings.d/*.json drop-ins after managed-settings.json (drop-in wins)", async () => {
    const dir = await tempDir("memlens-managed-");
    cleanup.push(dir);
    await writeFile(
      join(dir, "managed-settings.json"),
      JSON.stringify({ autoMemoryEnabled: true }),
      "utf8",
    );
    await mkdir(join(dir, "managed-settings.d"));
    await writeFile(
      join(dir, "managed-settings.d", "20-override.json"),
      JSON.stringify({ autoMemoryEnabled: false }),
      "utf8",
    );
    process.env["CLAUDE_CODE_MANAGED_SETTINGS_PATH"] = dir;
    process.env["CLAUDE_CONFIG_DIR"] = NONEXISTENT;
    const { resolveMemorySettings } = await load();
    const s = await resolveMemorySettings();
    expect(s.enabled).toBe(false);
    expect(s.enabledSource).toBe("settings");
    expect(s.enabledOrigin).toBe("policy");
  });

  it("applies CLAUDE_CODE_DISABLE_AUTO_MEMORY from the settings.json env block", async () => {
    // 公式は起動時に settings の env を process.env に書き込む (managedEnv.ts)。
    const home = await homeWithSettings({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } });
    process.env["CLAUDE_CONFIG_DIR"] = home;
    isolateManaged();
    const { resolveMemorySettings } = await load();
    const s = await resolveMemorySettings();
    expect(s.enabled).toBe(false);
    expect(s.enabledSource).toBe("env-disable");
    expect(s.enabledOrigin).toBe("user");
  });

  it("coerces numeric env values like the official schema", async () => {
    const home = await homeWithSettings({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: 1 } });
    process.env["CLAUDE_CONFIG_DIR"] = home;
    isolateManaged();
    const { resolveMemorySettings } = await load();
    const s = await resolveMemorySettings();
    expect(s.enabled).toBe(false);
  });

  it("lets a settings env value override the shell, and an empty value cancel a shell export", async () => {
    const home = await homeWithSettings({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "" } });
    process.env["CLAUDE_CONFIG_DIR"] = home;
    process.env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "1";
    isolateManaged();
    const { resolveMemorySettings } = await load();
    const s = await resolveMemorySettings();
    expect(s.enabled).toBe(true);
    expect(s.enabledSource).toBe("default");
  });

  it("gives managed env precedence over user env (policy is applied last)", async () => {
    const managedDir = await tempDir("memlens-managed-");
    cleanup.push(managedDir);
    await writeFile(
      join(managedDir, "managed-settings.json"),
      JSON.stringify({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } }),
      "utf8",
    );
    const home = await homeWithSettings({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" } });
    process.env["CLAUDE_CODE_MANAGED_SETTINGS_PATH"] = managedDir;
    process.env["CLAUDE_CONFIG_DIR"] = home;
    const { resolveMemorySettings } = await load();
    const s = await resolveMemorySettings();
    expect(s.enabled).toBe(false);
    expect(s.enabledOrigin).toBe("policy");
  });

  it("ignores launch-only variables in settings env (CLAUDE_CODE_REMOTE, SAFE_MODE, PROJECT_DIR_NAME)", async () => {
    const home = await homeWithSettings({
      env: {
        CLAUDE_CODE_REMOTE: "1",
        CLAUDE_CODE_SAFE_MODE: "1",
        CLAUDE_CODE_PROJECT_DIR_NAME: "work",
      },
    });
    process.env["CLAUDE_CONFIG_DIR"] = home;
    isolateManaged();
    const { resolveMemorySettings } = await load();
    const s = await resolveMemorySettings();
    expect(s.enabled).toBe(true);
    expect(s.enabledSource).toBe("default");
    expect(s.projectDirName).toBeNull();
  });

  it("reads CLAUDE_CONFIG_DIR / cowork override set in the user settings env", async () => {
    const other = await tempDir("memlens-config-");
    cleanup.push(other);
    const cowork = join(tmpdir(), "memlens-cowork-from-env");
    const home = await homeWithSettings({
      env: { CLAUDE_CONFIG_DIR: other, CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: cowork },
    });
    process.env["CLAUDE_CONFIG_DIR"] = home;
    isolateManaged();
    const { resolveMemorySettings } = await load();
    const s = await resolveMemorySettings();
    expect(s.configDir).toBe(other);
    expect(s.baseDir).toBe(other);
    expect(s.autoMemoryDirectorySource).toBe("cowork");
    expect(s.autoMemoryDirectoryOrigin).toBe("user");
  });

  it("tolerates a UTF-8 BOM in settings.json (PowerShell writes one)", async () => {
    const home = await homeWithSettings(null, `﻿${JSON.stringify({ autoMemoryEnabled: false })}`);
    process.env["CLAUDE_CONFIG_DIR"] = home;
    isolateManaged();
    const { resolveMemorySettings } = await load();
    const s = await resolveMemorySettings();
    expect(s.enabled).toBe(false);
    expect(s.enabledSource).toBe("settings");
    expect(s.enabledOrigin).toBe("user");
  });

  it("validates CLAUDE_CODE_PROJECT_DIR_NAME (needs CLAUDE_CONFIG_DIR, 1-64 safe chars, no device names)", async () => {
    const { resolveMemorySettings, validateProjectDirName } = await load();
    isolateManaged();
    process.env["CLAUDE_CODE_PROJECT_DIR_NAME"] = "work";
    // CLAUDE_CONFIG_DIR 無しでは無視される。
    expect((await resolveMemorySettings()).projectDirName).toBeNull();
    process.env["CLAUDE_CONFIG_DIR"] = NONEXISTENT;
    expect((await resolveMemorySettings()).projectDirName).toBe("work");

    expect(validateProjectDirName("tenant_a-01", true)).toBe("tenant_a-01");
    expect(validateProjectDirName("has space", true)).toBeNull();
    expect(validateProjectDirName("a/b", true)).toBeNull();
    expect(validateProjectDirName("x".repeat(65), true)).toBeNull();
    expect(validateProjectDirName("", true)).toBeNull();
    expect(validateProjectDirName("CON", true)).toBeNull();
    expect(validateProjectDirName("lpt1", true)).toBeNull();
    expect(validateProjectDirName("work", false)).toBeNull();
  });

  it("uses an MDM policy ahead of managed-settings.json (first source wins)", async () => {
    const managedDir = await tempDir("memlens-managed-");
    cleanup.push(managedDir);
    await writeFile(
      join(managedDir, "managed-settings.json"),
      JSON.stringify({ autoMemoryEnabled: true, env: { CLAUDE_CODE_SIMPLE: "1" } }),
      "utf8",
    );
    process.env["CLAUDE_CODE_MANAGED_SETTINGS_PATH"] = managedDir;
    process.env["CLAUDE_CONFIG_DIR"] = NONEXISTENT;
    const { resolveMemorySettings } = await load({
      admin: { autoMemoryEnabled: false },
      hkcu: null,
    });
    const s = await resolveMemorySettings();
    expect(s.policySource).toBe("mdm");
    // env は管理者ソース全体から変数ごとに集める → file の CLAUDE_CODE_SIMPLE が効く。
    expect(s.enabled).toBe(false);
    expect(s.enabledSource).toBe("env-simple");
    expect(s.enabledOrigin).toBe("policy");
  });

  it("does not let a drop-in with only control keys hide the HKCU policy", async () => {
    const managedDir = await tempDir("memlens-managed-");
    cleanup.push(managedDir);
    await mkdir(join(managedDir, "managed-settings.d"), { recursive: true });
    await writeFile(
      join(managedDir, "managed-settings.d", "10-wsl.json"),
      JSON.stringify({ wslInheritsWindowsSettings: true }),
      "utf8",
    );
    process.env["CLAUDE_CODE_MANAGED_SETTINGS_PATH"] = managedDir;
    process.env["CLAUDE_CONFIG_DIR"] = NONEXISTENT;
    const { resolveMemorySettings } = await load({
      admin: null,
      hkcu: { autoMemoryEnabled: false },
    });
    const s = await resolveMemorySettings();
    expect(s.policySource).toBe("hkcu");
    expect(s.enabled).toBe(false);
  });
});

describe("selectPolicyLayer", () => {
  it("returns nothing when no source has a policy key", async () => {
    const { selectPolicyLayer } = await import("../settings.ts");
    const layer = selectPolicyLayer({
      mdm: { managedSourcesBehavior: "first-wins" },
      file: null,
      hkcu: null,
    });
    expect(layer).toEqual({ settings: null, env: {}, source: null });
  });

  it("prefers MDM over the managed file and ignores the file's keys under first-wins", async () => {
    const { selectPolicyLayer } = await import("../settings.ts");
    const layer = selectPolicyLayer({
      mdm: { autoMemoryEnabled: false },
      file: { autoMemoryDirectory: "/x" },
      hkcu: { autoMemoryEnabled: true },
    });
    expect(layer.source).toBe("mdm");
    expect(layer.settings).toEqual({ autoMemoryEnabled: false });
  });

  it("combines admin sources under managedSourcesBehavior: merge (higher source wins per key)", async () => {
    const { selectPolicyLayer } = await import("../settings.ts");
    const layer = selectPolicyLayer({
      mdm: { autoMemoryEnabled: false, managedSourcesBehavior: "merge" },
      file: { autoMemoryEnabled: true, autoMemoryDirectory: "/x" },
      hkcu: null,
    });
    expect(layer.settings?.["autoMemoryEnabled"]).toBe(false);
    expect(layer.settings?.["autoMemoryDirectory"]).toBe("/x");
  });

  it("reads managedSourcesBehavior only from the highest-ranked source", async () => {
    const { selectPolicyLayer } = await import("../settings.ts");
    // 下位のソースが自分から merge に加わることはできない (docs/managed-settings.md)。
    const layer = selectPolicyLayer({
      mdm: { permissions: { deny: ["WebFetch"] } },
      file: { managedSourcesBehavior: "merge", autoMemoryEnabled: false },
      hkcu: null,
    });
    expect(layer.source).toBe("mdm");
    expect(layer.settings?.["autoMemoryEnabled"]).toBeUndefined();
  });

  it("merges env per variable across admin sources, higher source first", async () => {
    const { selectPolicyLayer } = await import("../settings.ts");
    const layer = selectPolicyLayer({
      mdm: { env: { A: "mdm" } },
      file: { env: { A: "file", B: "file" } },
      hkcu: { env: { C: "hkcu" } },
    });
    expect(layer.env).toEqual({ A: "mdm", B: "file" });
  });

  it("falls back to HKCU only when no admin source is present", async () => {
    const { selectPolicyLayer } = await import("../settings.ts");
    const layer = selectPolicyLayer({
      mdm: null,
      file: null,
      hkcu: { autoMemoryEnabled: false, env: { C: "hkcu" } },
    });
    expect(layer.source).toBe("hkcu");
    expect(layer.env).toEqual({ C: "hkcu" });
  });
});
