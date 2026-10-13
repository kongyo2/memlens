import { describe, expect, it } from "vitest";

import { mapConcurrent } from "../concurrency.ts";

describe("mapConcurrent", () => {
  it("preserves input order in the result array", async () => {
    const input = [10, 30, 20, 5, 25];
    const out = await mapConcurrent(input, 2, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      return n * 2;
    });
    expect(out).toEqual([20, 60, 40, 10, 50]);
  });

  it("returns immediately for empty input", async () => {
    const out = await mapConcurrent([], 4, async () => 1);
    expect(out).toEqual([]);
  });

  it("limits parallelism (no more than `limit` worker promises in flight)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const tasks = Array.from({ length: 20 }, (_, i) => i);
    await mapConcurrent(tasks, 4, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // 何かしらの async tick を挟むことで limit 違反が検出可能になる。
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return i;
    });
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("throws RangeError for invalid limit", async () => {
    await expect(mapConcurrent([1], 0, async () => 1)).rejects.toThrow(RangeError);
  });
});
