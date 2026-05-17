import { describe, expect, it } from "vitest";

import { MEMORY_CONSTANTS } from "@shared/schema/memory.ts";

import { truncateEntrypointContent } from "../truncate.ts";

const { MAX_ENTRYPOINT_LINES, MAX_ENTRYPOINT_BYTES } = MEMORY_CONSTANTS;

describe("truncateEntrypointContent", () => {
  it("passes through short content unchanged", () => {
    const src = "- one\n- two\n- three";
    const r = truncateEntrypointContent(src);
    expect(r.wasLineTruncated).toBe(false);
    expect(r.wasByteTruncated).toBe(false);
    expect(r.content).toBe(src);
    expect(r.lineCount).toBe(3);
    expect(r.byteCount).toBe(src.length);
  });

  it("returns empty result for whitespace-only input", () => {
    const r = truncateEntrypointContent("   \n\n  ");
    expect(r.content).toBe("");
    expect(r.lineCount).toBe(0);
    expect(r.byteCount).toBe(0);
  });

  it("truncates when exceeding line cap", () => {
    const lines = Array.from(
      { length: MAX_ENTRYPOINT_LINES + 10 },
      (_, i) => `- line ${String(i)}`,
    );
    const src = lines.join("\n");
    const r = truncateEntrypointContent(src);
    expect(r.wasLineTruncated).toBe(true);
    expect(r.lineCount).toBe(MAX_ENTRYPOINT_LINES + 10);
    expect(r.content).toContain("> WARNING:");
    expect(r.content).toContain(`${String(MAX_ENTRYPOINT_LINES + 10)} lines`);
  });

  it("truncates when exceeding byte cap with short lines but long total", () => {
    // 1 行を 200 char にして 200 行未満で 25KB を超える状況を作る。
    const oneLine = "x".repeat(300);
    const lines = Array.from({ length: 100 }, () => oneLine);
    const src = lines.join("\n");
    expect(src.length).toBeGreaterThan(MAX_ENTRYPOINT_BYTES);
    const r = truncateEntrypointContent(src);
    expect(r.wasByteTruncated).toBe(true);
    expect(r.wasLineTruncated).toBe(false);
    expect(r.content.length).toBeLessThan(src.length);
    expect(r.content).toContain("WARNING");
    expect(r.content).toContain("index entries are too long");
  });
});
