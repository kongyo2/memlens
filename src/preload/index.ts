import { contextBridge, ipcRenderer } from "electron";

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
import { IPC_CHANNELS } from "@shared/ipc/channels.ts";

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
