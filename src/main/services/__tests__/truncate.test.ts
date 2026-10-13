import { MEMORY_CONSTANTS } from "@shared/schema/memory.ts";
import { describe, expect, it } from "vitest";

import { truncateEntrypointContent } from "../truncate.ts";

const { MAX_ENTRYPOINT_LINES, MAX_ENTRYPOINT_BYTES } = MEMORY_CONSTANTS;

describe("truncateEntrypointContent", () => {
  it("passes through short content unchanged", () => {
    const src = "- one\n- two\n- three";
    const r = truncateEntrypointContent(src);
    expect(r.wasLineTruncated).toBe(false);
    expect(r.wasByteTruncated).toBe(false);
    expect(r.content).toBe(src);
    expect(r.dropped).toBe("");
    expect(r.lineCount).toBe(3);
    expect(r.loadedLineCount).toBe(3);
    expect(r.byteCount).toBe(src.length);
  });

  it("returns empty result for whitespace-only input (lineCount=1 matches official .split semantics)", () => {
    // 公式 memdir.ts:60 と同じ: trim 後の空文字列に対し split('\n') は [''] を返すので
    // lineCount は 1。 byteCount は trim 後の長さ 0。 表示側 (App / MemoryList) では
    // exists=false を先にチェックしているのでユーザには見えない。
    const r = truncateEntrypointContent("   \n\n  ");
    expect(r.content).toBe("");
    expect(r.lineCount).toBe(1);
    expect(r.byteCount).toBe(0);
    expect(r.wasLineTruncated).toBe(false);
    expect(r.wasByteTruncated).toBe(false);
  });

  it("cuts at the line cap and returns the dropped lines separately", () => {
    const lines = Array.from(
      { length: MAX_ENTRYPOINT_LINES + 10 },
      (_, i) => `- line ${String(i)}`,
    );
    const src = lines.join("\n");
    const r = truncateEntrypointContent(src);
    expect(r.wasLineTruncated).toBe(true);
    expect(r.lineCount).toBe(MAX_ENTRYPOINT_LINES + 10);
    expect(r.loadedLineCount).toBe(MAX_ENTRYPOINT_LINES);
    expect(r.content).toBe(lines.slice(0, MAX_ENTRYPOINT_LINES).join("\n"));
    expect(r.dropped).toBe(lines.slice(MAX_ENTRYPOINT_LINES).join("\n"));
    // 旧実装は公式の古い WARNING 文言を合成していた (v2.1.268 で文言が変わったため廃止)。
    expect(r.content).not.toContain("WARNING");
  });

  it("cuts at the last newline before the byte cap when lines are long", () => {
    const oneLine = "x".repeat(300);
    const lines = Array.from({ length: 100 }, () => oneLine);
    const src = lines.join("\n");
    expect(src.length).toBeGreaterThan(MAX_ENTRYPOINT_BYTES);
    const r = truncateEntrypointContent(src);
    expect(r.wasByteTruncated).toBe(true);
    expect(r.wasLineTruncated).toBe(false);
    expect(r.content.length).toBeLessThanOrEqual(MAX_ENTRYPOINT_BYTES);
    // 行の途中では切らない。
    expect(r.content.split("\n").every((l) => l === oneLine)).toBe(true);
    expect(r.loadedLineCount + r.dropped.split("\n").length).toBe(lines.length);
    // loaded + 改行 + dropped で元の内容に戻る。
    expect(`${r.content}\n${r.dropped}`).toBe(src);
  });

  it("applies the byte cap after the line cap", () => {
    // 200 行を超え、 かつ最初の 200 行だけでも 25KB を超える。
    const oneLine = "y".repeat(150);
    const lines = Array.from({ length: MAX_ENTRYPOINT_LINES + 20 }, () => oneLine);
    const r = truncateEntrypointContent(lines.join("\n"));
    expect(r.wasLineTruncated).toBe(true);
    expect(r.wasByteTruncated).toBe(true);
    expect(r.content.length).toBeLessThanOrEqual(MAX_ENTRYPOINT_BYTES);
    expect(r.loadedLineCount).toBeLessThan(MAX_ENTRYPOINT_LINES);
    expect(r.loadedLineCount + r.dropped.split("\n").length).toBe(lines.length);
  });

  it("cuts mid-line when a single line exceeds the byte cap", () => {
    const src = "z".repeat(MAX_ENTRYPOINT_BYTES + 100);
    const r = truncateEntrypointContent(src);
    expect(r.wasByteTruncated).toBe(true);
    expect(r.content.length).toBe(MAX_ENTRYPOINT_BYTES);
    expect(r.dropped.length).toBe(100);
  });
});
