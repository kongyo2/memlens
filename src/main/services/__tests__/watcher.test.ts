import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MemoryWatchEvent } from "@shared/ipc/channels.ts";
import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startWatch, stopWatch, stopWatchAll } from "../watcher.ts";

/**
 * watcher の refcount / 破棄まわりを実 fs.watch で検証する。
 *
 * watcher.ts は electron から型しか import しないので、 WebContents は
 * 必要なメソッドだけ持つ fake で代替できる。 イベント発火はデバウンス
 * (150ms) + OS 側のレイテンシがあるため、 vi.waitFor でポーリングする。
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

/**
 * target に change が届くまで file への書き込みを繰り返す。
 *
 * macOS の fs.watch (FSEvents) は libuv の別スレッドで非同期にストリームを
 * 開始するので、 startWatch 直後の書き込みが開始前に起きると通知されない
 * (プロセスで最初の watch はスレッド起動も挟むので特に起きやすい)。 1 回だけ
 * 書いて待つとリリースの macOS ジョブで間欠的に落ちたため、 届くまで書き直す。
 * watcher が閉じていれば何度書いても届かないので、 検証の意味は変わらない。
 */
async function writeUntilNotified(target: FakeWebContents, file: string): Promise<void> {
  await vi.waitFor(
    async () => {
      await writeFile(file, "x", "utf8");
      // デバウンス (150ms) + イベント伝搬を待ってから判定し、 未着なら次の周回で書き直す。
      await new Promise((r) => setTimeout(r, 300));
      expect(target.received.length).toBeGreaterThanOrEqual(1);
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
    await writeUntilNotified(t, join(dir, "a.md"));
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
    await writeUntilNotified(t2, join(dir, "c.md"));
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
