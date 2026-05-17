import { ipcMain } from "electron";

import { createMemoryRequestSchema } from "@shared/schema/memory.ts";
import { IPC_CHANNELS } from "@shared/ipc/channels.ts";

import * as memoryService from "../services/memory.ts";
import { startWatch, stopWatch } from "../services/watcher.ts";

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

export function registerMemoryIpc(): void {
  ipcMain.handle(IPC_CHANNELS.listProjects, async () => {
    return memoryService.listProjects();
  });

  ipcMain.handle(IPC_CHANNELS.listFiles, async (_event, memoryDir: unknown) => {
    return memoryService.listFiles(requireString(memoryDir, "memoryDir"));
  });

  ipcMain.handle(IPC_CHANNELS.readFile, async (_event, absPath: unknown) => {
    return memoryService.readFile(requireString(absPath, "absPath"));
  });

  ipcMain.handle(
    IPC_CHANNELS.writeFile,
    async (_event, absPath: unknown, raw: unknown) => {
      await memoryService.writeFile(
        requireString(absPath, "absPath"),
        requireString(raw, "raw"),
      );
    },
  );

  ipcMain.handle(IPC_CHANNELS.deleteFile, async (_event, absPath: unknown) => {
    await memoryService.deleteFile(requireString(absPath, "absPath"));
  });

  ipcMain.handle(IPC_CHANNELS.createFile, async (_event, req: unknown) => {
    const parsed = createMemoryRequestSchema.parse(req);
    return memoryService.createFile(parsed);
  });

  ipcMain.handle(IPC_CHANNELS.readIndex, async (_event, memoryDir: unknown) => {
    return memoryService.readIndex(requireString(memoryDir, "memoryDir"));
  });

  ipcMain.handle(
    IPC_CHANNELS.writeIndex,
    async (_event, memoryDir: unknown, content: unknown) => {
      await memoryService.writeIndex(
        requireString(memoryDir, "memoryDir"),
        requireString(content, "content"),
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.search,
    async (_event, memoryDir: unknown, query: unknown) => {
      return memoryService.search(
        requireString(memoryDir, "memoryDir"),
        requireString(query, "query"),
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.openInFolder,
    async (_event, absPath: unknown) => {
      await memoryService.openInFolder(requireString(absPath, "absPath"));
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.revealInEditor,
    async (_event, absPath: unknown) => {
      await memoryService.revealInEditor(requireString(absPath, "absPath"));
    },
  );

  ipcMain.handle(IPC_CHANNELS.getSettings, async () => {
    return memoryService.getSettings();
  });

  ipcMain.handle(
    IPC_CHANNELS.resolveProjectForPath,
    async (_event, absPath: unknown) => {
      return memoryService.resolveProjectForPath(
        requireString(absPath, "absPath"),
      );
    },
  );

  ipcMain.handle(IPC_CHANNELS.watchStart, (event, memoryDir: unknown) => {
    startWatch(event.sender, requireString(memoryDir, "memoryDir"));
  });
  ipcMain.handle(IPC_CHANNELS.watchStop, (_event, memoryDir: unknown) => {
    stopWatch(requireString(memoryDir, "memoryDir"));
  });
}
