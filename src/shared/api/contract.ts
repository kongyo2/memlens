import type { MemoryWatchEvent } from "../ipc/channels.ts";
import type {
  CreateMemoryRequest,
  GlobalMemorySearchResult,
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
  /**
   * memory ファイルの basename を変更する (親ディレクトリは変えない)。
   * 戻り値は rename 後の絶対パス。
   */
  renameFile(absPath: string, newFilename: string): Promise<string>;
  readIndex(memoryDir: string): Promise<MemoryIndexResult>;
  writeIndex(memoryDir: string, content: string): Promise<void>;
  search(memoryDir: string, query: string): Promise<MemorySearchResult>;
  /** 全プロジェクトを横断する本文検索。 */
  searchAll(query: string): Promise<GlobalMemorySearchResult>;
  openInFolder(absPath: string): Promise<void>;
  revealInEditor(absPath: string): Promise<void>;
  getSettings(): Promise<MemorySettings>;
  /** 現在 cwd や開いている path に対応する memoryDir を推定 (worktree 集約後)。 */
  resolveProjectForPath(absPath: string): Promise<MemoryProject | null>;
  /**
   * memoryDir の変更を購読。 戻り値の関数を呼ぶと購読解除する。 同じ memoryDir に
   * 対して複数回呼んだ場合 main 側で ref count され、 最後の unsubscribe で
   * watcher が実際に閉じる。
   */
  watch(
    memoryDir: string,
    listener: (event: MemoryWatchEvent) => void,
  ): () => void;
};

export type MemlensApi = {
  readonly versions: Versions;
  /** process.platform の生値 ("win32" | "darwin" | "linux" | ...)。 UI 文言の出し分け用。 */
  readonly platform: string;
  readonly memory: MemoryApi;
};

export type {
  CreateMemoryRequest,
  GlobalMemorySearchHit,
  GlobalMemorySearchResult,
  MemoryHeader,
  MemoryIndexResult,
  MemoryProject,
  MemorySearchHit,
  MemorySearchResult,
  MemorySettings,
  MemoryType,
} from "../schema/memory.ts";
export type { MemoryWatchEvent } from "../ipc/channels.ts";
