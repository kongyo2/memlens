/**
 * IPC 越しのエラーをユーザ向けの文に直す。
 *
 * ipcMain.handle の reject は renderer で
 * `Error invoking remote method 'memory:rename-file': Error: File already exists: x.md`
 * のような形になる。 前置きはユーザにとって意味が無いので落とす。
 */
const REMOTE_PREFIX_RE = /^Error invoking remote method '[^']*':\s*/;
const ERROR_NAME_PREFIX_RE = /^(?:[A-Z][A-Za-z]*Error|Error):\s*/;

export function formatError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(REMOTE_PREFIX_RE, "").replace(ERROR_NAME_PREFIX_RE, "");
}
