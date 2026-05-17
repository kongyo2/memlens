import { promises as fs } from "node:fs";
import { dirname, join, normalize, parse } from "node:path";

/**
 * Worktree も含めた canonical git root を返す。
 *
 * 公式 findCanonicalGitRoot (src/utils/git.ts:195) の最小再現:
 *   1. 入力 path から上に向かって `.git` を探す (親ディレクトリは並列 stat)
 *   2. `.git` が directory → そのまま canonical
 *   3. `.git` が file (worktree) → `gitdir:` を読み、`commondir` を辿って
 *      main repo の working tree を canonical として返す
 *   4. 見つからなければ null
 *
 * memlens は read-only なのでこの精度で十分。失敗時は呼び出し側で fallback を判断。
 */
export async function findCanonicalGitRoot(
  startPath: string,
): Promise<string | null> {
  const candidates = enumerateAncestors(startPath);
  const stats = await Promise.all(
    candidates.map(async (dir) => {
      const dotGit = join(dir, ".git");
      return { dir, dotGit, stat: await safeStat(dotGit) };
    }),
  );
  const hit = stats.find((s) => s.stat !== null);
  if (!hit) return null;
  if (hit.stat?.isDirectory()) {
    return hit.dir.normalize("NFC");
  }
  if (hit.stat?.isFile()) {
    const canonical = await resolveWorktreeMain(hit.dotGit);
    return (canonical ?? hit.dir).normalize("NFC");
  }
  return null;
}

function enumerateAncestors(startPath: string): string[] {
  const start = normalize(startPath);
  const root = parse(start).root;
  const out: string[] = [];
  let cur = start;
  while (cur && cur !== root && cur !== dirname(cur)) {
    out.push(cur);
    cur = dirname(cur);
  }
  return out;
}

type SafeStat = { isDirectory(): boolean; isFile(): boolean };

async function safeStat(path: string): Promise<SafeStat | null> {
  try {
    return await fs.stat(path);
  } catch {
    return null;
  }
}

/**
 * worktree の `.git` file を読んで main repo の workdir を返す。
 *
 *   `.git` file 内容: `gitdir: /path/to/main/.git/worktrees/<name>`
 *   その worktrees ディレクトリの `commondir` を読むと `..` などを返すので
 *   gitdir と結合して main の `.git` directory に到達する。
 *   その親が main の working directory。
 */
async function resolveWorktreeMain(dotGitFile: string): Promise<string | null> {
  try {
    const content = await fs.readFile(dotGitFile, { encoding: "utf8" });
    const match = /^gitdir:\s*(.+)\s*$/m.exec(content);
    if (!match || match[1] === undefined) return null;
    const gitDir = match[1].trim();
    const commonDirFile = join(gitDir, "commondir");
    let commonDir = gitDir;
    try {
      const rel = (
        await fs.readFile(commonDirFile, { encoding: "utf8" })
      ).trim();
      commonDir = normalize(join(gitDir, rel));
    } catch {
      // commondir が無ければ gitDir 自体を common とみなす
    }
    if (commonDir.endsWith(".git") || commonDir.endsWith(".git/")) {
      return dirname(commonDir);
    }
    return commonDir;
  } catch {
    return null;
  }
}
