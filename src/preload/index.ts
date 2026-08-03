import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type {
  CreateMemoryRequest,
  MemlensApi,
  MemoryApi,
  MemoryHeader,
  MemoryIndexResult,
  MemoryProject,
  MemorySearchResult,
  MemorySettings,
  ParsedMemoryFile,
} from "@shared/api/contract.ts";
import { IPC_CHANNELS, type MemoryWatchEvent } from "@shared/ipc/channels.ts";

const memoryApi: MemoryApi = {
  listProjects: () =>
    ipcRenderer.invoke(IPC_CHANNELS.listProjects) as Promise<
      readonly MemoryProject[]
    >,
  listFiles: (memoryDir) =>
    ipcRenderer.invoke(IPC_CHANNELS.listFiles, memoryDir) as Promise<
      readonly MemoryHeader[]
    >,
  readFile: (absPath) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.readFile,
      absPath,
    ) as Promise<ParsedMemoryFile>,
  writeFile: (absPath, raw) =>
    ipcRenderer.invoke(IPC_CHANNELS.writeFile, absPath, raw) as Promise<void>,
  deleteFile: (absPath) =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteFile, absPath) as Promise<void>,
  createFile: (req: CreateMemoryRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.createFile, req) as Promise<MemoryHeader>,
  readIndex: (memoryDir) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.readIndex,
      memoryDir,
    ) as Promise<MemoryIndexResult>,
  writeIndex: (memoryDir, content) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.writeIndex,
      memoryDir,
      content,
    ) as Promise<void>,
  search: (memoryDir, query) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.search,
      memoryDir,
      query,
    ) as Promise<MemorySearchResult>,
  openInFolder: (absPath) =>
    ipcRenderer.invoke(IPC_CHANNELS.openInFolder, absPath) as Promise<void>,
  revealInEditor: (absPath) =>
    ipcRenderer.invoke(IPC_CHANNELS.revealInEditor, absPath) as Promise<void>,
  getSettings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getSettings) as Promise<MemorySettings>,
  resolveProjectForPath: (absPath) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.resolveProjectForPath,
      absPath,
    ) as Promise<MemoryProject | null>,
  watch: (memoryDir, listener) => {
    /**
     * main 側 watcher が error を出したら (Windows で memoryDir が削除/移動された
     * 等)、 main は entry を閉じる。 renderer 側で再 subscribe を試みないと
     * auto-refresh が無音で止まる。 ここで backoff 付き再 subscribe を行う。
     */
    let disposed = false;
    let backoffMs = 200;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const dispatch = (payload: MemoryWatchEvent): void => {
      listener(payload);
      if (payload.kind === "error") {
        if (disposed || retryTimer !== null) return;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          start();
          // 連続失敗で 5s 上限まで指数バックオフ。 成功 (change 受信) でリセット。
          backoffMs = Math.min(backoffMs * 2, 5_000);
        }, backoffMs);
      } else if (payload.kind === "change") {
        backoffMs = 200;
      }
    };

    let pendingStart: Promise<void> | null = null;

    const start = (): void => {
      if (disposed) return;
      const p = ipcRenderer
        .invoke(IPC_CHANNELS.watchStart, memoryDir)
        .then(() => undefined)
        .catch(() => {
          // main 側の guard で弾かれた / IPC 自体が失敗した場合は watcher が
          // 張られていない。 watcher error と同じ形で伝え、 同じ backoff 再試行
          // ループに乗せる (黙って自動更新が死ぬのを防ぐ)。
          if (!disposed) {
            dispatch({ memoryDir, kind: "error", path: null });
          }
        });
      pendingStart = p;
      void p.finally(() => {
        if (pendingStart === p) pendingStart = null;
      });
    };

    const handler = (
      _event: IpcRendererEvent,
      payload: MemoryWatchEvent,
    ): void => {
      if (payload.memoryDir !== memoryDir) return;
      dispatch(payload);
    };

    ipcRenderer.on(IPC_CHANNELS.watchEvent, handler);
    start();

    return () => {
      disposed = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      ipcRenderer.removeListener(IPC_CHANNELS.watchEvent, handler);
      const stop = (): void => {
        void ipcRenderer.invoke(IPC_CHANNELS.watchStop, memoryDir);
      };
      // watchStart が main 側でまだ処理中 (path guard の await 中) のうちに
      // watchStop が先に完了すると、 stop は no-op になり、 遅れて登録された
      // watcher を誰も解除できなくなる (StrictMode の setup/cleanup/setup や
      // 高速なプロジェクト切替で顕在化)。 start の完了を待ってから stop を送り、
      // main 側の refcount 増減を必ず start → stop の順にする。
      if (pendingStart !== null) {
        void pendingStart.then(stop, stop);
      } else {
        stop();
      }
    };
  },
};

const api: MemlensApi = {
  versions: {
    electron: process.versions["electron"] ?? "",
    chrome: process.versions["chrome"] ?? "",
    node: process.versions["node"] ?? "",
  },
  memory: memoryApi,
};

contextBridge.exposeInMainWorld("memlens", api);
