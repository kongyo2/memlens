import type { MemoryWatchEvent } from "../ipc/channels.ts";
import type {
  CreateMemoryRequest,
  GlobalMemorySearchResult,
  MemoryHeader,
  MemoryIndexResult,
  MemoryProject,
  MemorySearchResult,
  MemorySettings,
  RenameResult,
  WriteExpectation,
  WriteResult,
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
  readonly byteSize: number;
  /** frontmatter `modified` (Claude Code v2.1.214+) の epoch ms。 */
  readonly modifiedMs: number | null;
  /** frontmatter のフェンスはあるが YAML として読めない。 */
  readonly frontmatterInvalid: boolean;
};

/** memory 操作 API。 */
export type MemoryApi = {
  listProjects(): Promise<readonly MemoryProject[]>;
  listFiles(memoryDir: string): Promise<readonly MemoryHeader[]>;
  /** 一覧 (mtime 降順 200 件) に入らないファイルでもヘッダを得る。 */
  readHeader(absPath: string): Promise<MemoryHeader>;
  readFile(absPath: string): Promise<ParsedMemoryFile>;
  /**
   * memory ファイルを保存する。 expectation は編集開始時の内容で、 ディスク上の
   * 内容が変わっていれば何も書かずに conflict を返す (null なら上書き)。
   */
  writeFile(absPath: string, raw: string, expectation: WriteExpectation): Promise<WriteResult>;
  /** removeIndexEntries なら MEMORY.md のそのファイルだけを指すエントリ行も消す。 */
  deleteFile(
    absPath: string,
    options: { readonly removeIndexEntries: boolean },
  ): Promise<{ readonly indexEntriesRemoved: number }>;
  createFile(req: CreateMemoryRequest): Promise<MemoryHeader>;
  /**
   * memory ファイルの basename を変更する (親ディレクトリは変えない)。
   * updateIndexLinks なら MEMORY.md 内のリンクも新しい名前に張り替える。
   */
  renameFile(
    absPath: string,
    newFilename: string,
    options: { readonly updateIndexLinks: boolean },
  ): Promise<RenameResult>;
  readIndex(memoryDir: string): Promise<MemoryIndexResult>;
  writeIndex(
    memoryDir: string,
    content: string,
    expectation: WriteExpectation,
  ): Promise<WriteResult>;
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
  watch(memoryDir: string, listener: (event: MemoryWatchEvent) => void): () => void;
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
  IndexHealth,
  MemoryHeader,
  MemoryIndexResult,
  MemoryProject,
  MemoryProjectKind,
  MemorySearchHit,
  MemorySearchResult,
  MemorySettings,
  MemoryType,
  RenameResult,
  ValueOrigin,
  WriteExpectation,
  WriteResult,
} from "../schema/memory.ts";
export type { MemoryWatchEvent } from "../ipc/channels.ts";
