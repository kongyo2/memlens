import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";

/**
 * 公式 readFileInRange (src/utils/readFileInRange.ts) の最小 subset。 frontmatter
 * 取得用に「先頭 N 行 or 64KB のどちらか早い方まで」読む。 大きな memory file
 * (数 MB) を 200 個 listFiles するとき、 fs.readFile 全読みでは GUI が一瞬固まる
 * ため、 file handle を使った逐次読みに切り替える。
 *
 * 改行は LF (0x0A) のみカウント (CRLF は LF を含むので 1 行扱いになる)。
 * 戻り値はテキスト (UTF-8) と mtimeMs。
 */
export type FileHead = {
  readonly content: string;
  readonly mtimeMs: number;
};

const READ_CHUNK = 16 * 1024;
const READ_HARD_CAP_BYTES = 64 * 1024;

export async function readFileHead(filePath: string, maxLines: number): Promise<FileHead | null> {
  let handle: FileHandle;
  try {
    handle = await fs.open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const decoder = new TextDecoder("utf-8");
    let collected = "";
    let lineCount = 0;
    let read = 0;
    let position = 0;
    const buf = Buffer.allocUnsafe(READ_CHUNK);
    // 連続 read はファイル位置に依存するので並列化できない。 oxlint の
    // no-await-in-loop は disable する (順次読みが本質)。
    // oxlint-disable-next-line no-await-in-loop
    while (read < READ_HARD_CAP_BYTES && lineCount < maxLines) {
      // oxlint-disable-next-line no-await-in-loop
      const { bytesRead } = await handle.read(buf, 0, buf.length, position);
      if (bytesRead === 0) break;
      collected += decoder.decode(buf.subarray(0, bytesRead), { stream: true });
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0x0a) lineCount++;
      }
      read += bytesRead;
      position += bytesRead;
      if (lineCount >= maxLines) break;
    }
    collected += decoder.decode();
    return { content: collected, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
