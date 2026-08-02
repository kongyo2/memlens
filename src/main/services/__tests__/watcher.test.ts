import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MemoryWatchEvent } from "@shared/ipc/channels.ts";

import { startWatch, stopWatch, stopWatchAll } from "../watcher.ts";

/**
 * watcher の refcount / 破棄まわりを実 fs.watch で検証する。
 *
 * watcher.ts は electron から型しか import しないので、 WebContents は
 * 必要なメソッドだけ持つ fake で代替できる。 イベント発火はデバウンス
 * (150ms) + inotify レイテンシがあるため、 vi.waitFor でポーリングする。
 */

type FakeWebContents = WebContents & {
  readonly received: MemoryWatchEvent[];
  destroy(): void;
};

function fakeWebContents(): FakeWebContents {
  const received: MemoryWatchEvent[] = [];
  const listeners = new Map<string, Set<() => void>>();
  let destroyed = false;
  const fake = {
    received,
    isDestroyed: () => destroyed,
    send: (_channel: string, payload: MemoryWatchEvent) => {
      received.push(payload);
    },
    once: (event: string, cb: () => void) => {
      const set = listeners.get(event) ?? new Set<() => void>();
      set.add(cb);
      listeners.set(event, set);
      return fake;
    },
    removeListener: (event: string, cb: () => void) => {
      listeners.get(event)?.delete(cb);
      return fake;
    },
    destroy: () => {
      destroyed = true;
      const set = listeners.get("destroyed");
      listeners.delete("destroyed");
      if (set) for (const cb of set) cb();
    },
  };
  return fake as unknown as FakeWebContents;
}

async function waitForEvents(
  target: FakeWebContents,
  atLeast: number,
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(target.received.length).toBeGreaterThanOrEqual(atLeast);
    },
    { timeout: 4_000, interval: 50 },
  );
}

describe("watcher refcounting", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "memlens-watch-"));
  });

  afterEach(async () => {
    stopWatchAll();
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the shared watcher alive while the same target holds another subscription", async () => {
    const t = fakeWebContents();
    startWatch(t, dir);
    startWatch(t, dir);
    // 片方だけ解除 → もう片方の購読で change がまだ届くこと。
    stopWatch(t, dir);
    await writeFile(join(dir, "a.md"), "x", "utf8");
    await waitForEvents(t, 1);
    expect(t.received[0]?.kind).toBe("change");
  });

  it("closes the watcher when the last subscription for a target is stopped", async () => {
    const t = fakeWebContents();
    startWatch(t, dir);
    startWatch(t, dir);
    stopWatch(t, dir);
    stopWatch(t, dir);
    await writeFile(join(dir, "b.md"), "x", "utf8");
    // デバウンス + イベント伝搬より十分長く待って、 何も届かないことを確認。
    await new Promise((r) => setTimeout(r, 500));
    expect(t.received.length).toBe(0);
  });

  it("keeps notifying the remaining target when another target unsubscribes", async () => {
    const t1 = fakeWebContents();
    const t2 = fakeWebContents();
    startWatch(t1, dir);
    startWatch(t2, dir);
    stopWatch(t1, dir);
    await writeFile(join(dir, "c.md"), "x", "utf8");
    await waitForEvents(t2, 1);
    expect(t1.received.length).toBe(0);
  });

  it("cleans up when a target's WebContents is destroyed without watchStop", async () => {
    const t = fakeWebContents();
    startWatch(t, dir);
    t.destroy();
    await writeFile(join(dir, "d.md"), "x", "utf8");
    await new Promise((r) => setTimeout(r, 500));
    expect(t.received.length).toBe(0);
  });
});
