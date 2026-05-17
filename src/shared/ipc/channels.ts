/**
 * preload / main の IPC channel 名を 1 か所に集約。
 *
 * 名前のずれで silent fail しないよう、両側がこの定数を import する。
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
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
