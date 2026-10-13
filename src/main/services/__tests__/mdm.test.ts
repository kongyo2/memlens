import { afterEach, describe, expect, it } from "vitest";

import {
  macOSPlistPaths,
  parseRegQueryStdout,
  parseSettingsJson,
  readMdmSettings,
  setMdmReaderForTests,
} from "../mdm.ts";

describe("parseRegQueryStdout (official mdm/settings.ts port)", () => {
  it("extracts a REG_SZ value", () => {
    const stdout = [
      "",
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\ClaudeCode",
      '    Settings    REG_SZ    {"autoMemoryEnabled":false}',
      "",
    ].join("\r\n");
    expect(parseRegQueryStdout(stdout)).toBe('{"autoMemoryEnabled":false}');
  });

  it("accepts REG_EXPAND_SZ and is case-insensitive about the value name", () => {
    const stdout = '    settings    REG_EXPAND_SZ    {"a":1}   \n';
    expect(parseRegQueryStdout(stdout)).toBe('{"a":1}');
  });

  it("returns null when the value is absent or of another type", () => {
    expect(
      parseRegQueryStdout("ERROR: The system was unable to find the specified registry key"),
    ).toBeNull();
    expect(parseRegQueryStdout("    Settings    REG_DWORD    0x1")).toBeNull();
  });
});

describe("parseSettingsJson", () => {
  it("parses a non-empty object (BOM tolerated)", () => {
    expect(parseSettingsJson('﻿{"autoMemoryEnabled":false}')).toEqual({
      autoMemoryEnabled: false,
    });
  });

  it("treats empty objects, arrays and broken JSON as no source", () => {
    expect(parseSettingsJson("{}")).toBeNull();
    expect(parseSettingsJson("[1]")).toBeNull();
    expect(parseSettingsJson("{nope")).toBeNull();
  });
});

describe("macOSPlistPaths", () => {
  it("checks the per-user managed preferences before the device-wide one", () => {
    expect(macOSPlistPaths("alice")).toEqual([
      "/Library/Managed Preferences/alice/com.anthropic.claudecode.plist",
      "/Library/Managed Preferences/com.anthropic.claudecode.plist",
    ]);
    expect(macOSPlistPaths("")).toEqual([
      "/Library/Managed Preferences/com.anthropic.claudecode.plist",
    ]);
  });
});

describe("readMdmSettings", () => {
  afterEach(() => {
    setMdmReaderForTests(null);
  });

  it("caches the OS read and swallows reader failures", async () => {
    let calls = 0;
    setMdmReaderForTests(async () => {
      calls++;
      throw new Error("boom");
    });
    await expect(readMdmSettings()).resolves.toEqual({ admin: null, hkcu: null });
    await readMdmSettings();
    expect(calls).toBe(1);
  });
});
