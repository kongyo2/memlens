import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
  "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
  "CLAUDE_CODE_SIMPLE",
  "CLAUDE_CODE_REMOTE",
  "CLAUDE_CODE_REMOTE_MEMORY_DIR",
  "CLAUDE_SETTINGS_PATH",
  "CLAUDE_CODE_MANAGED_SETTINGS_PATH",
  "CLAUDE_COWORK_MEMORY_PATH_OVERRIDE",
  "CLAUDE_CONFIG_DIR",
] as const;

function clearEnv(): void {
  for (const k of ENV_KEYS) {
    delete process.env[k];
  }
}

describe("resolveMemorySettings", () => {
  beforeEach(() => {
    clearEnv();
    vi.resetModules();
  });

  afterEach(() => {
    clearEnv();
    vi.restoreAllMocks();
  });

  it("returns enabled=true with default source when nothing is configured", async () => {
    const { resolveMemorySettings } = await import("../settings.ts");
    // settings.json も無いことを保証するため CLAUDE_CONFIG_DIR を /nonexistent に。
    process.env["CLAUDE_CONFIG_DIR"] = "/__memlens_test_nonexistent__";
    const s = await resolveMemorySettings();
    expect(s.enabled).toBe(true);
    expect(s.enabledSource).toBe("default");
    expect(s.autoMemoryDirectory).toBeNull();
  });

  it("respects CLAUDE_CODE_DISABLE_AUTO_MEMORY truthy", async () => {
    const { resolveMemorySettings } = await import("../settings.ts");
    process.env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "1";
    process.env["CLAUDE_CONFIG_DIR"] = "/__memlens_test_nonexistent__";
    const s = await resolveMemorySettings();
    expect(s.enabled).toBe(false);
    expect(s.enabledSource).toBe("env-disable");
  });

  it("respects CLAUDE_CODE_DISABLE_AUTO_MEMORY explicit false (forces ON)", async () => {
    const { resolveMemorySettings } = await import("../settings.ts");
    process.env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "0";
    process.env["CLAUDE_CONFIG_DIR"] = "/__memlens_test_nonexistent__";
    const s = await resolveMemorySettings();
    expect(s.enabled).toBe(true);
    expect(s.enabledSource).toBe("env-disable");
  });

  it("respects CLAUDE_CODE_SIMPLE → OFF", async () => {
    const { resolveMemorySettings } = await import("../settings.ts");
    process.env["CLAUDE_CODE_SIMPLE"] = "true";
    process.env["CLAUDE_CONFIG_DIR"] = "/__memlens_test_nonexistent__";
    const s = await resolveMemorySettings();
    expect(s.enabled).toBe(false);
    expect(s.enabledSource).toBe("env-simple");
  });

  it("respects CLAUDE_CODE_REMOTE without REMOTE_MEMORY_DIR → OFF", async () => {
    const { resolveMemorySettings } = await import("../settings.ts");
    process.env["CLAUDE_CODE_REMOTE"] = "1";
    process.env["CLAUDE_CONFIG_DIR"] = "/__memlens_test_nonexistent__";
    const s = await resolveMemorySettings();
    expect(s.enabled).toBe(false);
    expect(s.enabledSource).toBe("env-remote");
  });

  it("uses REMOTE_MEMORY_DIR as baseDir override", async () => {
    const { resolveMemorySettings } = await import("../settings.ts");
    process.env["CLAUDE_CODE_REMOTE_MEMORY_DIR"] = "/tmp/remote-memory";
    process.env["CLAUDE_CONFIG_DIR"] = "/__memlens_test_nonexistent__";
    const s = await resolveMemorySettings();
    expect(s.baseDir).toBe("/tmp/remote-memory");
    expect(s.remoteMemoryDir).toBe("/tmp/remote-memory");
  });

  it("accepts on/off as truthy/falsy env values (parity with official isEnvTruthy)", async () => {
    const { resolveMemorySettings } = await import("../settings.ts");
    process.env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "on";
    process.env["CLAUDE_CONFIG_DIR"] = "/__memlens_test_nonexistent__";
    let s = await resolveMemorySettings();
    expect(s.enabled).toBe(false);
    expect(s.enabledSource).toBe("env-disable");

    process.env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "OFF";
    s = await resolveMemorySettings();
    expect(s.enabled).toBe(true);
    expect(s.enabledSource).toBe("env-disable");
  });

  it("honors CLAUDE_COWORK_MEMORY_PATH_OVERRIDE as highest-priority directory override", async () => {
    const { resolveMemorySettings } = await import("../settings.ts");
    process.env["CLAUDE_CONFIG_DIR"] = "/__memlens_test_nonexistent__";
    // 公式 validateMemoryPath は expandTilde=false で env を受け、 絶対 path のみ。
    process.env["CLAUDE_COWORK_MEMORY_PATH_OVERRIDE"] = "/tmp/cowork-mem";
    const s = await resolveMemorySettings();
    // validateMemoryPath は node:path normalize を通すため、 Windows では
    // separator が `\` に変わる ('/tmp/cowork-mem' → '\tmp\cowork-mem\')。
    expect(s.autoMemoryDirectory).toMatch(/^[/\\]tmp[/\\]cowork-mem[/\\]?$/);
    expect(s.autoMemoryDirectorySource).toBe("cowork");
  });

  it("rejects bare tilde / non-absolute CLAUDE_COWORK_MEMORY_PATH_OVERRIDE silently", async () => {
    const { resolveMemorySettings } = await import("../settings.ts");
    process.env["CLAUDE_CONFIG_DIR"] = "/__memlens_test_nonexistent__";
    process.env["CLAUDE_COWORK_MEMORY_PATH_OVERRIDE"] = "~/cowork-mem";
    const s = await resolveMemorySettings();
    // env で tilde 展開は不許可 (公式 paths.ts:122 と一致)。
    expect(s.autoMemoryDirectory).toBeNull();
  });

  it("merges managed-settings.d/*.json drop-ins after managed-settings.json (drop-in wins)", async () => {
    // 公式 loadManagedFileSettings (src/utils/settings/settings.ts:74) と同等の
    // ふるまいを検証。 base ファイルに autoMemoryEnabled=true、 drop-in で
    // autoMemoryEnabled=false を上書きすると enabled は false になる。
    const dir = await mkdtemp(join(tmpdir(), "memlens-managed-"));
    try {
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
      process.env["CLAUDE_CONFIG_DIR"] = "/__memlens_test_nonexistent__";
      const { resolveMemorySettings } = await import("../settings.ts");
      const s = await resolveMemorySettings();
      expect(s.enabled).toBe(false);
      expect(s.enabledSource).toBe("settings");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
