import type { Dict } from "./locales/types.ts";

/** `1 file` / `3 files` (ja は単複同形)。 */
export function formatFileCount(t: Dict, count: number): string {
  return `${String(count)} ${count === 1 ? t.units.file : t.units.files}`;
}

/** `1 line` / `200 lines`。 */
export function formatLineCount(t: Dict, count: number): string {
  return `${String(count)} ${count === 1 ? t.units.line : t.units.lines}`;
}
