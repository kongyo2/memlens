import type {
  CreateMemoryRequest,
  MemoryHeader,
  MemoryIndexResult,
  MemoryProject,
  MemorySearchResult,
  MemorySettings,
} from "../schema/memory.ts";

/**
 * memlens の preload → renderer 契約。
 *
 * main が ipcMain.handle で実装し、preload が contextBridge.exposeInMainWorld で
 * renderer に晒す。 renderer はこの型のみを参照し値の実装は知らない。
 */

export type Versions = {
  readonly electron: string;
  readonly chrome: string;
  readonly node: string;
};

/** 単一の memory ファイルをパースした結果。 */
export type ParsedMemoryFile = {
  readonly path: string;
  readonly raw: string;
  readonly frontmatter: Readonly<Record<string, unknown>> | null;
  readonly body: string;
  readonly mtimeMs: number;
};

/** memory 操作 API。 */
export type MemoryApi = {
  listProjects(): Promise<readonly MemoryProject[]>;
  listFiles(memoryDir: string): Promise<readonly MemoryHeader[]>;
  readFile(absPath: string): Promise<ParsedMemoryFile>;
  writeFile(absPath: string, raw: string): Promise<void>;
  deleteFile(absPath: string): Promise<void>;
  createFile(req: CreateMemoryRequest): Promise<MemoryHeader>;
  readIndex(memoryDir: string): Promise<MemoryIndexResult>;
  writeIndex(memoryDir: string, content: string): Promise<void>;
  search(memoryDir: string, query: string): Promise<MemorySearchResult>;
  openInFolder(absPath: string): Promise<void>;
  revealInEditor(absPath: string): Promise<void>;
  getSettings(): Promise<MemorySettings>;
  /** 現在 cwd や開いている path に対応する memoryDir を推定 (worktree 集約後)。 */
  resolveProjectForPath(absPath: string): Promise<MemoryProject | null>;
};

export type MemlensApi = {
  readonly versions: Versions;
  readonly memory: MemoryApi;
};

export type {
  CreateMemoryRequest,
  MemoryHeader,
  MemoryIndexResult,
  MemoryProject,
  MemorySearchHit,
  MemorySearchResult,
  MemorySettings,
  MemoryType,
} from "../schema/memory.ts";
