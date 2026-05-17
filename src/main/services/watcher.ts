import { type FSWatcher, watch } from "node:fs";

import type { WebContents } from "electron";

import { IPC_CHANNELS, type MemoryWatchEvent } from "@shared/ipc/channels.ts";

/**
 * memoryDir の変更を fs.watch で検知し、 renderer に push する watcher。
 *
 * 一度に複数の memoryDir を watch しうる (UI でプロジェクトを切替えるたびに
 * 新しい dir を購読) ので Map で管理。 同じ dir に対して購読が重複したときは
 * watcher を共有する (ref count)。
 *
 * fs.watch は Windows / macOS / Linux 毎に挙動が違う:
 *   - Windows: recursive: true をサポートする (subdirectory にも追従)
 *   - macOS: recursive: true をサポートする
 *   - Linux: recursive: true は無視される → 直下しか見えない
 * memlens の memoryDir は最大 1 階層 (logs/YYYY/MM/...) ぐらいなので、
 * Linux でも MEMORY.md / 直下 .md は補足できる。 KAIROS 日次ログには弱いが
 * 主要 UC は救える。
 *
 * 連続イベントは 150ms で debounce してまとめて 1 通知に集約する
 * (editor 保存で write → rename → close など複数飛んでくるため)。
 */

type Entry = {
  readonly memoryDir: string;
  readonly watcher: FSWatcher;
  /**
   * この memoryDir を購読中の WebContents 集合。
   *
   * 複数の renderer (例: 開発中の DevTools window) や、 同じ window 内の複数
   * subscribe 呼び出しが共存しうる。 同じ target が複数回 add されても Set なので
   * 一回しか入らないため、 stop は per-target で減らす。
   */
  readonly targets: Set<WebContents>;
  /** debounce 用 timer。 */
  pending: NodeJS.Timeout | null;
  /** debounce 中に最初に拾った変化 path (UI ログ用)。 */
  pendingPath: string | null;
};

const DEBOUNCE_MS = 150;
const watchers = new Map<string, Entry>();

function broadcast(entry: Entry, payload: MemoryWatchEvent): void {
  for (const target of entry.targets) {
    if (target.isDestroyed()) continue;
    target.send(IPC_CHANNELS.watchEvent, payload);
  }
}

export function startWatch(target: WebContents, memoryDir: string): void {
  const key = memoryDir;
  const existing = watchers.get(key);
  if (existing) {
    existing.targets.add(target);
    return;
  }
  let watcher: FSWatcher;
  try {
    watcher = watch(memoryDir, { recursive: true });
  } catch {
    // recursive 非対応 (古い Linux 等) は recursive なしで再試行。
    try {
      watcher = watch(memoryDir);
    } catch {
      // fs.watch が完全に失敗するケース (ENOENT / EPERM 等)。 立ち上げ直後の
      // この target に対して error を 1 通流して、 renderer 側で再 subscribe を
      // 判断できるようにする。
      if (!target.isDestroyed()) {
        target.send(IPC_CHANNELS.watchEvent, {
          memoryDir,
          kind: "error",
          path: null,
        } satisfies MemoryWatchEvent);
      }
      return;
    }
  }
  const entry: Entry = {
    memoryDir,
    watcher,
    targets: new Set([target]),
    pending: null,
    pendingPath: null,
  };
  watcher.on(
    "change",
    (_eventType: string, filename: string | Buffer | null) => {
      if (entry.pendingPath === null) {
        entry.pendingPath = typeof filename === "string" ? filename : null;
      }
      if (entry.pending !== null) return;
      entry.pending = setTimeout(() => {
        entry.pending = null;
        const payload: MemoryWatchEvent = {
          memoryDir,
          kind: "change",
          path: entry.pendingPath,
        };
        entry.pendingPath = null;
        broadcast(entry, payload);
      }, DEBOUNCE_MS);
    },
  );
  watcher.on("error", () => {
    // watcher が死んだら subscribers に error を通知して、 renderer 側で
    // backoff 付きの再 subscribe ができるようにする (Windows で memoryDir が
    // 削除・移動されたとき EPERM が来るケースを救う)。 entry は閉じる。
    broadcast(entry, {
      memoryDir,
      kind: "error",
      path: null,
    });
    stopAll(memoryDir);
  });
  watchers.set(key, entry);
}

export function stopWatch(target: WebContents, memoryDir: string): void {
  const entry = watchers.get(memoryDir);
  if (!entry) return;
  entry.targets.delete(target);
  if (entry.targets.size > 0) return;
  stopAll(memoryDir);
}

function stopAll(memoryDir: string): void {
  const entry = watchers.get(memoryDir);
  if (!entry) return;
  if (entry.pending !== null) clearTimeout(entry.pending);
  try {
    entry.watcher.close();
  } catch {
    /* ignore */
  }
  watchers.delete(memoryDir);
}

/**
 * window が閉じたとき / app 終了時に全 watcher を解放する。
 */
export function stopWatchAll(): void {
  for (const key of Array.from(watchers.keys())) {
    stopAll(key);
  }
}
