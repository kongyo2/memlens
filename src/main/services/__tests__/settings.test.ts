import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
  "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
  "CLAUDE_CODE_SIMPLE",
  "CLAUDE_CODE_REMOTE",
  "CLAUDE_CODE_REMOTE_MEMORY_DIR",
  "CLAUDE_SETTINGS_PATH",
  "CLAUDE_CODE_MANAGED_SETTINGS_PATH",
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
});
