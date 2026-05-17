import { describe, expect, it } from "vitest";

import { formatFileSize, memoryAgeDays } from "../format.ts";

/**
 * 公式 formatFileSize (src/utils/format.ts:9) と 100% 一致することを担保。
 * truncateEntrypointContent の WARNING 文字列を grep するロジックを Claude Code
 * 本体が将来追加した場合に備え、 表記揺れを許さない。
 */
describe("formatFileSize", () => {
  it("uses 'bytes' (not 'B') for sub-KB sizes", () => {
    expect(formatFileSize(0)).toBe("0 bytes");
    expect(formatFileSize(512)).toBe("512 bytes");
    expect(formatFileSize(1023)).toBe("1023 bytes");
  });

  it("uses 'KB' with no space and trims trailing .0", () => {
    expect(formatFileSize(1024)).toBe("1KB");
    expect(formatFileSize(1536)).toBe("1.5KB");
    expect(formatFileSize(25_000)).toBe("24.4KB");
  });

  it("scales to MB and GB without spaces", () => {
    expect(formatFileSize(1024 * 1024)).toBe("1MB");
    expect(formatFileSize(1024 * 1024 * 1024)).toBe("1GB");
  });
});

describe("memoryAgeDays", () => {
  it("returns 0 for now and rounds down", () => {
    const now = 1_700_000_000_000;
    expect(memoryAgeDays(now, now)).toBe(0);
    expect(memoryAgeDays(now - 86_399_000, now)).toBe(0);
    expect(memoryAgeDays(now - 86_400_001, now)).toBe(1);
  });

  it("clamps negative (future mtime) to 0", () => {
    const now = 1_700_000_000_000;
    expect(memoryAgeDays(now + 999_999, now)).toBe(0);
  });

  it("counts full days for older entries", () => {
    const now = 1_700_000_000_000;
    expect(memoryAgeDays(now - 30 * 86_400_000, now)).toBe(30);
  });
});
