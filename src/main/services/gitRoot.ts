import { promises as fs } from "node:fs";
import { basename, dirname, join, normalize, parse, resolve } from "node:path";

/**
 * Worktree も含めた canonical git root を返す。
 *
 * 公式 findCanonicalGitRoot (src/utils/git.ts:195) の Node 移植:
 *
 *   1. 入力 path から上に向かって `.git` を探す (親ディレクトリは並列 stat)
 *   2. `.git` が directory → そのまま canonical
 *   3. `.git` が file (worktree) → `gitdir:` を読み、 `commondir` を辿って
 *      main repo の working tree を canonical として返す
 *      - SECURITY 検証 (`.git` の内容は untrusted。 悪意ある repo は commondir を
 *        被害者の信頼済み path に向け、 .claude/settings.json のフック実行を
 *        誘発し得る — 公式コメント参照):
 *          a. worktreeGitDir の親が <commonDir>/worktrees であること
 *          b. <worktreeGitDir>/gitdir の back-link が realpath(<gitRoot>)/.git と一致
 *      - 失敗時 (検証 NG / 例外 / commondir 無し submodule) は元の gitRoot を返す
 *   4. bare-repo worktree: commonDir の basename が `.git` でなければ
 *      commonDir 自身を canonical として返す (公式 git.ts:173)
 *   5. 見つからなければ null
 *
 * memlens は read-only だが、 sanitizePath への入力 path 統一に使うので
 * 公式と canonical が一致する必要がある (一致しないと別の sanitized 名になり
 * project list に出ない)。
 */
export async function findCanonicalGitRoot(startPath: string): Promise<string | null> {
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
    const canonical = await resolveWorktreeMain(hit.dir, hit.dotGit);
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

async function safeRealpath(path: string): Promise<string | null> {
  try {
    return await fs.realpath(path);
  } catch {
    return null;
  }
}

async function safeReadFile(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, { encoding: "utf8" });
  } catch {
    return null;
  }
}

/**
 * worktree の `.git` file を読んで main repo の workdir を返す。
 *
 *   `.git` file 内容: `gitdir: /path/to/main/.git/worktrees/<name>`
 *   そこに `commondir` (相対 path) と `gitdir` (back-link) が置かれている。
 *   両方を読んで公式 src/utils/git.ts:123-179 と同じ検証 + canonical 解決を行う。
 */
async function resolveWorktreeMain(gitRoot: string, dotGitFile: string): Promise<string | null> {
  const content = await safeReadFile(dotGitFile);
  if (content === null) return null;
  const m = /^gitdir:\s*(.+)\s*$/m.exec(content);
  if (!m || m[1] === undefined) return null;
  // gitdir 値は dotGit が居るディレクトリ (gitRoot) からの相対 path として解釈する。
  const worktreeGitDir = resolve(gitRoot, m[1].trim());

  const commonDirRel = await safeReadFile(join(worktreeGitDir, "commondir"));
  if (commonDirRel === null) {
    // commondir が無い → submodule など。 元の gitRoot を canonical 扱い (公式と同じ)。
    return null;
  }
  const commonDir = resolve(worktreeGitDir, commonDirRel.trim());

  // SECURITY 検証 1: worktreeGitDir の親 dir が <commonDir>/worktrees であること。
  // これにより、 attacker が commondir で gitRoot 外を指しても弾ける。
  if (resolve(dirname(worktreeGitDir)) !== join(commonDir, "worktrees")) {
    return null;
  }

  // SECURITY 検証 2: <worktreeGitDir>/gitdir の back-link が realpath(gitRoot)/.git に一致。
  // git は worktree 作成時に strbuf_realpath() を使うので、 シンボリックリンク
  // 解決後の path で比較する必要がある (macOS /tmp → /private/tmp 等)。
  const backlinkRaw = await safeReadFile(join(worktreeGitDir, "gitdir"));
  if (backlinkRaw === null) return null;
  const backlink = await safeRealpath(backlinkRaw.trim());
  const realGitRoot = await safeRealpath(gitRoot);
  if (backlink === null || realGitRoot === null || backlink !== join(realGitRoot, ".git")) {
    return null;
  }

  // bare-repo の場合は commonDir の basename が `.git` にならない (e.g. `repo.git`)。
  // そのケースは commonDir 自体を canonical project root として返す
  // (公式 git.ts:173, anthropics/claude-code#27994 参照)。
  if (basename(commonDir) !== ".git") {
    return commonDir.normalize("NFC");
  }
  return dirname(commonDir).normalize("NFC");
}
