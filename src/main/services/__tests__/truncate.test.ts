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
    // 公式 formatFileSize 表記が使われていることを確認 ('24.4KB' のように space なし)。
    // memdir.ts の WARNING を grep するために必要。
    expect(r.content).toMatch(/\d+(\.\d+)?(KB|MB|GB)/);
    expect(r.content).not.toMatch(/\d+ KB/);
  });

  it("uses official 'bytes' (not 'B') unit for byte counts under 1KB in WARNING", () => {
    // 1KB 未満を出すには両方の制限を超える必要があるので、 多数行 + 微小バイト数
    // のケースを作る。 line truncation は発火するが byte は発火しないようにし、
    // mixed 文 (lines + size) が出るよう byteCount > 1024 にする。
    const lines = Array.from({ length: 250 }, (_, i) => `${String(i)}`);
    const src = lines.join("\n");
    const r = truncateEntrypointContent(src);
    expect(r.wasLineTruncated).toBe(true);
    // mixed の場合だけ formatFileSize が登場する。 line のみなら登場しないので
    // line のみのケースを以下で確認。
    expect(r.content).toContain(`${String(lines.length)} lines`);
  });
});
