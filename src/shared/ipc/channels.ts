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
  readIndex: "memory:read-index",
  writeIndex: "memory:write-index",
  search: "memory:search",
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
 * watcher が emit するイベント形。 `kind: 'change'` は memoryDir 配下で何か変化が
 * あったというだけの粗い通知 (renderer 側で listFiles/readIndex を再 invoke する)。
 * `path` は変化したパス (debounced first match) で、 ログ用途のみ。
 */
export type MemoryWatchEvent = {
  readonly memoryDir: string;
  readonly kind: "change";
  readonly path: string | null;
};
