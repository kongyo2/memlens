/**
 * preload / main の IPC channel 名を 1 か所に集約。
 *
 * 名前のずれで silent fail しないよう、両側がこの定数を import する。
 *
 * `memory:watch-*` は main → renderer の push channel。 contextBridge では
 * 直接 IpcRenderer を expose できないので、 preload で `onMemoryDirChanged`
 * subscribe API として薄くラップする。
 */
export const IPC_CHANNELS = {
  listProjects: "memory:list-projects",
  listFiles: "memory:list-files",
  readFile: "memory:read-file",
  writeFile: "memory:write-file",
  deleteFile: "memory:delete-file",
  createFile: "memory:create-file",
  renameFile: "memory:rename-file",
  readIndex: "memory:read-index",
  writeIndex: "memory:write-index",
  search: "memory:search",
  searchAll: "memory:search-all",
  openInFolder: "memory:open-in-folder",
  revealInEditor: "memory:reveal-in-editor",
  getSettings: "memory:get-settings",
  resolveProjectForPath: "memory:resolve-project-for-path",
  watchStart: "memory:watch-start",
  watchStop: "memory:watch-stop",
  watchEvent: "memory:watch-event",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/**
 * watcher が emit するイベント形。
 *
 *   - `kind: 'change'` は memoryDir 配下で何か変化があったという粗い通知
 *     (renderer 側で listFiles / readIndex を再 invoke する)。
 *   - `kind: 'error'` は fs.watch が死んだ通知 (Windows で EPERM 等)。 これを
 *     受けた renderer は backoff 付きで watchStart を再 invoke することで購読を
 *     継続できる。
 *
 * `path` は変化したパス (debounced first match) で、 ログ用途のみ。 error の場合は
 * 常に null。
 */
export type MemoryWatchEvent = {
  readonly memoryDir: string;
  readonly kind: "change" | "error";
  readonly path: string | null;
};
