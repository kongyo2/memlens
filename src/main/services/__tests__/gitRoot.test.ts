import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findCanonicalGitRoot } from "../gitRoot.ts";

/**
 * findCanonicalGitRoot は公式 src/utils/git.ts:195 の Node 移植。 worktree の
 * セキュリティ検証 (commondir の親 / back-link 一致) は memory directory の
 * sanitize 名を決める入力 path として canonical にするために重要なので、
 * ここで明示的に固める。
 */
describe("findCanonicalGitRoot", () => {
  let work: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "memlens-git-"));
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("returns the directory containing .git when .git is a directory", async () => {
    const repo = join(work, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    const got = await findCanonicalGitRoot(repo);
    expect(got).toBe(repo);
  });

  it("returns null when no .git is found up the tree", async () => {
    const got = await findCanonicalGitRoot(work);
    expect(got).toBeNull();
  });

  it("resolves a real git worktree back to the main repo working directory", async () => {
    // git worktree add の標準レイアウトを手で再現する。
    //   <repo>/.git/                      ← main repo の .git directory
    //   <repo>/.git/worktrees/feature/    ← worktree gitdir
    //   <repo>/.git/worktrees/feature/commondir → "../.."  (= <repo>/.git)
    //   <repo>/.git/worktrees/feature/gitdir    → "<wt>/.git" (back-link)
    //   <wt>/.git                          ← worktree から見た .git file
    const repo = join(work, "main");
    const mainGit = join(repo, ".git");
    const wt = join(work, "feature");
    const wtGitDir = join(mainGit, "worktrees", "feature");
    await mkdir(wtGitDir, { recursive: true });
    await mkdir(wt, { recursive: true });
    await writeFile(join(wtGitDir, "commondir"), "../..\n", "utf8");
    await writeFile(join(wtGitDir, "gitdir"), `${join(wt, ".git")}\n`, "utf8");
    await writeFile(join(wt, ".git"), `gitdir: ${wtGitDir}\n`, "utf8");

    const got = await findCanonicalGitRoot(wt);
    expect(got).toBe(repo);
  });

  it("rejects a tampered .git file whose commondir points outside (returns original gitRoot)", async () => {
    // 攻撃者が clone を被害者の信頼済み path にリダイレクトするケース。
    // commondir が gitdir の親と整合しないので canonical 化失敗 → 元の dir を返す。
    const wt = join(work, "evil");
    const wtGitDir = join(work, "elsewhere");
    await mkdir(wtGitDir, { recursive: true });
    await mkdir(wt, { recursive: true });
    // commondir が <wtGitDir>/.. ではない場所を指す = invalid
    await writeFile(join(wtGitDir, "commondir"), "../../totally-unrelated", "utf8");
    await writeFile(join(wtGitDir, "gitdir"), `${join(wt, ".git")}\n`, "utf8");
    await writeFile(join(wt, ".git"), `gitdir: ${wtGitDir}\n`, "utf8");

    const got = await findCanonicalGitRoot(wt);
    expect(got).toBe(wt);
  });

  it("rejects a tampered back-link that does not point back to <gitRoot>/.git", async () => {
    const repo = join(work, "good");
    const mainGit = join(repo, ".git");
    const wt = join(work, "borrowed");
    const wtGitDir = join(mainGit, "worktrees", "borrowed");
    await mkdir(wtGitDir, { recursive: true });
    await mkdir(wt, { recursive: true });
    await writeFile(join(wtGitDir, "commondir"), "../..\n", "utf8");
    // back-link が wt の .git ではなく別の場所を指す → 検証失敗
    await writeFile(join(wtGitDir, "gitdir"), `${join(work, "victim", ".git")}\n`, "utf8");
    await writeFile(join(wt, ".git"), `gitdir: ${wtGitDir}\n`, "utf8");

    const got = await findCanonicalGitRoot(wt);
    expect(got).toBe(wt);
  });

  it("handles symlinked gitRoot (e.g. macOS /tmp → /private/tmp) via realpath", async () => {
    // realpath で同じ場所を指せば検証は通る。 シンボリックリンク経由でアクセス
    // した場合でも canonical の main repo を返せること。
    const repo = join(work, "src");
    const mainGit = join(repo, ".git");
    const wt = join(work, "wt-real");
    const wtGitDir = join(mainGit, "worktrees", "wt-real");
    await mkdir(wtGitDir, { recursive: true });
    await mkdir(wt, { recursive: true });
    await writeFile(join(wtGitDir, "commondir"), "../..\n", "utf8");
    await writeFile(join(wtGitDir, "gitdir"), `${join(wt, ".git")}\n`, "utf8");
    await writeFile(join(wt, ".git"), `gitdir: ${wtGitDir}\n`, "utf8");

    const wtSymlink = join(work, "wt-via-symlink");
    await symlink(wt, wtSymlink);

    const got = await findCanonicalGitRoot(wtSymlink);
    expect(got).toBe(repo);
  });
});
