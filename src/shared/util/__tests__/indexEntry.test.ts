import { describe, expect, it } from "vitest";

import { buildIndexEntry, entryLength, formatLinkTarget } from "../indexEntry.ts";

/** 公式の index エントリ形式: `- [Title](file.md) — one-line hook`。 */
describe("buildIndexEntry", () => {
  it("builds the official one-line entry", () => {
    expect(buildIndexEntry("User role", "user_role.md", "Senior Go engineer, new to React")).toBe(
      "- [User role](user_role.md) — Senior Go engineer, new to React",
    );
  });

  it("drops the separator when there is no hook", () => {
    expect(buildIndexEntry("Notes", "notes.md", "   ")).toBe("- [Notes](notes.md)");
  });

  it("collapses line breaks and runs of whitespace into one line", () => {
    expect(buildIndexEntry("Multi\nline", "a.md", "first\r\n  second\tthird")).toBe(
      "- [Multi line](a.md) — first second third",
    );
  });

  it("escapes brackets and backslashes in the title", () => {
    expect(buildIndexEntry("[draft] a\\b", "d.md", "")).toBe("- [\\[draft\\] a\\\\b](d.md)");
  });

  it("wraps targets with spaces or parentheses in angle brackets", () => {
    expect(buildIndexEntry("T", "my notes.md", "")).toBe("- [T](<my notes.md>)");
    expect(formatLinkTarget("v(2).md")).toBe("<v(2).md>");
    expect(formatLinkTarget("sub/file.md")).toBe("sub/file.md");
  });
});

describe("entryLength", () => {
  it("counts code points, so emoji and CJK count once each", () => {
    expect(entryLength("abc")).toBe(3);
    expect(entryLength("日本語")).toBe(3);
    expect(entryLength("🚀x")).toBe(2);
  });
});
