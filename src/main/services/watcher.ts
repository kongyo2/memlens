import { type FSWatcher, watch } from "node:fs";

import type { WebContents } from "electron";

import { IPC_CHANNELS, type MemoryWatchEvent } from "@shared/ipc/channels.ts";

/**
 * memoryDir の変更を fs.watch で検知し、 renderer に push する watcher。
 *
 * 一度に複数の memoryDir を watch しうる (UI でプロジェクトを切替えるたびに
 * 新しい dir を購読) ので Map で管理。 同じ dir に対して購読が重複したときは
 * watcher を共有し、 購読数を refcount で数える。
 *
 * fs.watch の recursive: true は Node 20+ の Windows / macOS / Linux すべてで
 * サポートされる。 非対応環境 (古い libuv など) では ERR_FEATURE_UNAVAILABLE
 * が投げられるので、 非 recursive で再試行するフォールバックを残している
 * (その場合は直下の変更のみ検知)。
 *
 * 連続イベントは 150ms で debounce してまとめて 1 通知に集約する
 * (editor 保存で write → rename → close など複数飛んでくるため)。
 */

type TargetRecord = {
  /**
   * この (memoryDir, WebContents) 組の購読数。
   *
   * 同じ window が同じ dir を複数回 watch することがある (複数コンポーネント /
   * React StrictMode の二重 effect)。 Set だと最初の unsubscribe が残りの購読者
   * ごと共有 watcher を閉じてしまうため、 購読数で管理する。
   */
  count: number;
  /** window 破棄時に leak しないための後始末 listener (once)。 */
  readonly onDestroyed: () => void;
};

type Entry = {
  readonly memoryDir: string;
  readonly watcher: FSWatcher;
  readonly targets: Map<WebContents, TargetRecord>;
  /** debounce 用 timer。 */
  pending: NodeJS.Timeout | null;
  /** debounce 中に最初に拾った変化 path (UI ログ用)。 */
  pendingPath: string | null;
};

const DEBOUNCE_MS = 150;
const watchers = new Map<string, Entry>();

function broadcast(entry: Entry, payload: MemoryWatchEvent): void {
  for (const [target, rec] of Array.from(entry.targets)) {
    if (target.isDestroyed()) {
      // destroyed イベントを取りこぼした場合の保険。 拾ったらここで除去する。
      entry.targets.delete(target);
      target.removeListener("destroyed", rec.onDestroyed);
      continue;
    }
    target.send(IPC_CHANNELS.watchEvent, payload);
  }
  if (entry.targets.size === 0) {
    stopAll(entry.memoryDir);
  }
}

function addTarget(entry: Entry, target: WebContents): void {
  const existing = entry.targets.get(target);
  if (existing) {
    existing.count++;
    return;
  }
  const onDestroyed = (): void => {
    // renderer が watchStop を送れずに消えたケース (window close 等)。
    const current = watchers.get(entry.memoryDir);
    if (!current) return;
    current.targets.delete(target);
    if (current.targets.size === 0) stopAll(entry.memoryDir);
  };
  entry.targets.set(target, { count: 1, onDestroyed });
  target.once("destroyed", onDestroyed);
}

export function startWatch(target: WebContents, memoryDir: string): void {
  const existing = watchers.get(memoryDir);
  if (existing) {
    addTarget(existing, target);
    return;
  }
  let watcher: FSWatcher;
  try {
    watcher = watch(memoryDir, { recursive: true });
  } catch {
    // recursive 非対応環境は recursive なしで再試行。
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
    targets: new Map(),
    pending: null,
    pendingPath: null,
  };
  addTarget(entry, target);
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
  watchers.set(memoryDir, entry);
}

export function stopWatch(target: WebContents, memoryDir: string): void {
  const entry = watchers.get(memoryDir);
  if (!entry) return;
  const rec = entry.targets.get(target);
  if (!rec) return;
  if (rec.count > 1) {
    rec.count--;
    return;
  }
  entry.targets.delete(target);
  if (!target.isDestroyed()) {
    target.removeListener("destroyed", rec.onDestroyed);
  }
  if (entry.targets.size === 0) {
    stopAll(memoryDir);
  }
}

function stopAll(memoryDir: string): void {
  const entry = watchers.get(memoryDir);
  if (!entry) return;
  if (entry.pending !== null) clearTimeout(entry.pending);
  for (const [target, rec] of entry.targets) {
    if (!target.isDestroyed()) {
      target.removeListener("destroyed", rec.onDestroyed);
    }
  }
  entry.targets.clear();
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
