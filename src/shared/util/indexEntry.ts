/**
 * MEMORY.md のエントリ行の組み立て (main と renderer で共用)。
 *
 * 公式の保存手順 Step 2 (src/memdir/memdir.ts buildMemoryLines):
 *   "add a pointer to that file in MEMORY.md ... each entry should be one line,
 *    under ~150 characters: `- [Title](file.md) — one-line hook`"
 */

/**
 * リンク target を Markdown に書く形にする。 `%` `#` `?` はリンク先では
 * パーセントエンコード / fragment / query として読まれるのでエンコードし
 * (index の解析はデコードして戻す)、 空白や括弧を含む名前は `<...>` 形式
 * (CommonMark) で囲む (memlens のファイル名検証で `<>` は弾かれている)。
 * suffix (`#anchor` 等) はエンコードせずに後ろに付ける。
 */
export function formatLinkTarget(relPath: string, suffix = ""): string {
  const encoded = relPath.replace(
    /[%#?]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const target = `${encoded}${suffix}`;
  return /[\s()]/.test(target) ? `<${target}>` : target;
}

/** Markdown のリンクテキストとして安全な形にする。 */
function escapeLinkText(text: string): string {
  return text.replace(/[\\[\]]/g, (c) => `\\${c}`);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 公式の index エントリ形式 `- [Title](file.md) — one-line hook` を作る。
 * 改行は空白に潰して 1 行に収める。 hook が空ならリンクだけの行にする。
 */
export function buildIndexEntry(title: string, relPath: string, hook: string): string {
  const head = `- [${escapeLinkText(oneLine(title))}](${formatLinkTarget(relPath)})`;
  const tail = oneLine(hook);
  return tail.length > 0 ? `${head} — ${tail}` : head;
}

/** 行の文字数 (code point 単位。 公式の「~150 characters」と同じ数え方)。 */
export function entryLength(line: string): number {
  return [...line].length;
}
