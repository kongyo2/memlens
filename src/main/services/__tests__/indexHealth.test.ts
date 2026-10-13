import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  analyzeIndex,
  buildIndexEntry,
  formatLinkTarget,
  normalizeLinkTarget,
  removeIndexEntries,
  retargetIndexLinks,
  scanIndexText,
} from "../indexHealth.ts";

describe("normalizeLinkTarget", () => {
  it("keeps relative memory paths and decodes them", () => {
    expect(normalizeLinkTarget("user_role.md")).toBe("user_role.md");
    expect(normalizeLinkTarget("./team/rule.md#why")).toBe("team/rule.md");
    expect(normalizeLinkTarget("<my notes.md>")).toBe("my notes.md");
    expect(normalizeLinkTarget("my%20notes.md")).toBe("my notes.md");
  });

  it("ignores URLs, anchors, absolute and home paths", () => {
    for (const target of [
      "https://example.com/x.md",
      "mailto:a@b.c",
      "#section",
      "/etc/passwd",
      "~/notes.md",
      "C:\\notes.md",
    ]) {
      expect(normalizeLinkTarget(target)).toBeNull();
    }
  });
});

describe("scanIndexText", () => {
  it("collects inline and reference links with raw line numbers", () => {
    const raw = ["# Index", "- [A](a.md) — hook", "- [B][b]", "", "[b]: b.md"].join("\n");
    const scan = scanIndexText(raw);
    expect(scan.links).toEqual([
      { line: 2, target: "a.md" },
      { line: 5, target: "b.md" },
    ]);
    expect(scan.hasFrontmatter).toBe(false);
  });

  it("skips frontmatter, fenced code and HTML comments", () => {
    const raw = [
      "---",
      "note: [x](fm.md)",
      "---",
      "```",
      "- [code](code.md)",
      "```",
      "<!-- [hidden](hidden.md)",
      "still hidden -->",
      "- [real](real.md)",
    ].join("\n");
    const scan = scanIndexText(raw);
    expect(scan.hasFrontmatter).toBe(true);
    expect(scan.links).toEqual([{ line: 9, target: "real.md" }]);
  });

  it("flags entries longer than ~200 characters (counting code points)", () => {
    const ok = `- [a](a.md) — ${"あ".repeat(150)}`;
    const long = `- [b](b.md) — ${"x".repeat(200)}`;
    const scan = scanIndexText(`${ok}\n${long}\n`);
    expect(scan.longEntries.map((e) => e.line)).toEqual([2]);
    expect(scan.longEntries[0]?.preview.endsWith("…")).toBe(true);
  });
});

describe("index entry helpers", () => {
  it("builds the official `- [Title](file.md) — hook` entry", () => {
    expect(buildIndexEntry("User role", "user_role.md", "senior engineer")).toBe(
      "- [User role](user_role.md) — senior engineer",
    );
    expect(buildIndexEntry("x", "a b.md", "")).toBe("- [x](<a b.md>)");
    expect(formatLinkTarget("plain.md")).toBe("plain.md");
  });

  it("retargets only links that resolve to the renamed file", () => {
    const raw = '- [a](a.md) and [a again](a.md "title a.md")\n- [c](c.md)\n[ref]: ./a.md\n';
    const out = retargetIndexLinks(raw, "a.md", "b.md");
    expect(out.count).toBe(3);
    expect(out.text).toBe(
      '- [a](b.md) and [a again](b.md "title a.md")\n- [c](c.md)\n[ref]: ./b.md\n',
    );
  });

  it("does not rewrite links inside comments or code fences", () => {
    const raw = "<!-- [a](a.md) -->\n```\n[a](a.md)\n```\n";
    expect(retargetIndexLinks(raw, "a.md", "b.md")).toEqual({ text: raw, count: 0 });
  });

  it("removes only entries whose links all point at the removed file", () => {
    const raw = "# Index\r\n- [Gone](gone.md)\r\n- [Mixed](gone.md) [k](k.md)\r\n- plain\r\n";
    expect(removeIndexEntries(raw, "gone.md")).toEqual({
      text: "# Index\r\n- [Mixed](gone.md) [k](k.md)\r\n- plain\r\n",
      count: 1,
    });
  });
});

describe("analyzeIndex", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "memlens-health-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports dangling links and top-level orphans", async () => {
    await mkdir(join(dir, "team"), { recursive: true });
    await writeFile(join(dir, "linked.md"), "x", "utf8");
    await writeFile(join(dir, "orphan.md"), "x", "utf8");
    // サブディレクトリ (team/ 等) は別の index が扱うので orphan 判定しない。
    await writeFile(join(dir, "team", "t.md"), "x", "utf8");
    const health = await analyzeIndex(
      dir,
      "- [l](linked.md)\n- [m](missing.md)\n- [up](../outside.md)\n",
    );
    expect(health.danglingLinks).toEqual([{ line: 2, target: "missing.md" }]);
    expect(health.orphans).toEqual(["orphan.md"]);
    expect(health.linkedFiles).toEqual(["linked.md"]);
  });

  it("treats every top-level memory as not indexed when MEMORY.md is missing", async () => {
    await writeFile(join(dir, "a.md"), "x", "utf8");
    await writeFile(join(dir, "MEMORY.md.bak"), "x", "utf8");
    const health = await analyzeIndex(dir, null);
    expect(health.orphans).toEqual(["a.md"]);
    expect(health.danglingLinks).toEqual([]);
  });
});
