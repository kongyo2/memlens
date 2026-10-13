import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { MEMORY_CONSTANTS } from "@shared/schema/memory.ts";

import { sanitizePath } from "./sanitize.ts";

/**
 * project フォルダ名 (sanitize 済み) から元のワークツリーパスを確実に求める。
 *
 * sanitizePath は非英数字をすべて `-` にする破壊的変換なので、 名前だけからは
 * `/Users/me/my-app` と `/Users/me/my/app` を区別できない (guessProjectPath は
 * best-effort)。 一方、 同じフォルダに置かれるセッション記録 (`<session>.jsonl`)
 * の各エントリは `"cwd"` を持つ (公式 SDK の listSessions もこれを cwd として
 * 返す)。 その cwd を sanitize してフォルダ名と一致すれば、 それが正しい復元。
 *
 * memory は canonical git root、 transcript は起動 cwd で keying されるので、
 * サブディレクトリでしか起動していない repo には一致する transcript が無い
 * (その場合は null を返し、 呼び出し側が推測にフォールバックする)。
 */

/** 公式 LITE_READ_BUF_SIZE と同じ: transcript の先頭だけを読む。 */
const HEAD_BYTES = 64 * 1024;
/** 1 フォルダで覗く transcript 数の上限 (先頭が summary 行だけのファイルに備える)。 */
const MAX_TRANSCRIPTS = 3;
/** 見つからなかった結果を覚えておく時間 (新しいセッションが来たら拾い直す)。 */
const NEGATIVE_TTL_MS = 60_000;

const found = new Map<string, string>();
const missing = new Map<string, number>();

/** 公式 unescapeJsonString (src/utils/sessionStoragePortable.ts:39)。 */
function unescapeJsonString(raw: string): string {
  if (!raw.includes("\\")) return raw;
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/**
 * 公式 extractJsonStringField (src/utils/sessionStoragePortable.ts:53) の移植。
 * 完全な JSON parse をせずに `"key":"value"` の最初の値を取り出す
 * (途中で切れた行でも動く)。
 */
export function extractJsonStringField(text: string, key: string): string | undefined {
  for (const pattern of [`"${key}":"`, `"${key}": "`]) {
    const idx = text.indexOf(pattern);
    if (idx < 0) continue;
    const valueStart = idx + pattern.length;
    let i = valueStart;
    while (i < text.length) {
      if (text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text[i] === '"') return unescapeJsonString(text.slice(valueStart, i));
      i++;
    }
  }
  return undefined;
}

/** cwd が project フォルダ名に sanitize されるか (長い path は hash 接尾辞を除いて比較)。 */
export function cwdMatchesProjectName(cwd: string, name: string): boolean {
  const sanitized = sanitizePath(cwd);
  if (sanitized === name) return true;
  const { MAX_SANITIZED_LENGTH } = MEMORY_CONSTANTS;
  // >200 文字の path は Bun.hash / djb2 で接尾辞が変わりうる (findProjectDir と同じ考え方)。
  return (
    sanitized.length > MAX_SANITIZED_LENGTH &&
    name.length > MAX_SANITIZED_LENGTH &&
    sanitized.slice(0, MAX_SANITIZED_LENGTH) === name.slice(0, MAX_SANITIZED_LENGTH)
  );
}

async function readHead(path: string): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await fs.open(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function scanTranscripts(projectDir: string, name: string): Promise<string | null> {
  let transcripts: string[];
  try {
    const entries = await fs.readdir(projectDir, { withFileTypes: true });
    transcripts = entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => e.name)
      .slice(0, MAX_TRANSCRIPTS);
  } catch {
    return null;
  }
  for (const file of transcripts) {
    // 1 つ目で見つかるのが普通なので順番に読む (並列にすると無駄読みが増える)。
    // oxlint-disable-next-line no-await-in-loop
    const head = await readHead(join(projectDir, file));
    const cwd = head === null ? undefined : extractJsonStringField(head, "cwd");
    if (cwd !== undefined && cwdMatchesProjectName(cwd, name)) return cwd.normalize("NFC");
  }
  return null;
}

/**
 * project フォルダ (`<projects>/<name>/`) の transcript から元のパスを返す。
 * 一致する transcript が無ければ null。
 */
export async function projectPathFromTranscripts(
  projectDir: string,
  name: string,
): Promise<string | null> {
  const key = `${projectDir}\0${name}`;
  const hit = found.get(key);
  if (hit !== undefined) return hit;
  const missedAt = missing.get(key);
  if (missedAt !== undefined && Date.now() - missedAt < NEGATIVE_TTL_MS) return null;
  const cwd = await scanTranscripts(projectDir, name);
  if (cwd === null) {
    missing.set(key, Date.now());
    return null;
  }
  missing.delete(key);
  found.set(key, cwd);
  return cwd;
}

/** テスト用: キャッシュを空にする。 */
export function clearProjectPathCache(): void {
  found.clear();
  missing.clear();
}
