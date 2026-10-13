import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { MEMORY_CONSTANTS } from "@shared/schema/memory.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setMdmReaderForTests } from "../mdm.ts";
import {
  createFile,
  deleteFile,
  listFiles,
  listProjects,
  readFile as readMemoryFile,
  readHeader,
  readIndex,
  renameFile,
  resolveProjectForPath,
  revealInEditor,
  search,
  searchAll,
  writeFile as writeMemoryFile,
  writeIndex,
} from "../memory.ts";
import { clearProjectPathCache } from "../projectPath.ts";
import { sanitizePath } from "../sanitize.ts";

const ISOLATED_ENV_KEYS = [
  "CLAUDE_CODE_REMOTE_MEMORY_DIR",
  "CLAUDE_COWORK_MEMORY_PATH_OVERRIDE",
  "CLAUDE_CODE_PROJECT_DIR_NAME",
  "CLAUDE_SETTINGS_PATH",
  "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
] as const;

/**
 * memory service の I/O 系を実 fs で検証する。 settings は env 経由で
 * `CLAUDE_CONFIG_DIR` を tmpdir に差し向けて隔離する (`shell.openPath` 等は
 * テストでは触らない)。
 *
 * Electron の `shell` import は side effect を持たないので unit test 内で
 * services を直接 import できる (確認済み: vitest config の environment は
 * "node", electron はテストでは require 解決されない)。
 *
 * NOTE: 一部の case では sanitizePath / projectsRoot の挙動が `process.platform`
 * に依存するので path 比較は startsWith / 部分一致で記述する。
 */
describe("memory service (fs integration)", () => {
  let home: string;
  let projectsRoot: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "memlens-home-"));
    projectsRoot = join(home, "projects");
    await mkdir(projectsRoot, { recursive: true });
    process.env["CLAUDE_CONFIG_DIR"] = home;
    // 端末の managed settings / MDM に左右されないよう隔離する。
    process.env["CLAUDE_CODE_MANAGED_SETTINGS_PATH"] = join(home, "no-managed");
    for (const key of ISOLATED_ENV_KEYS) delete process.env[key];
    setMdmReaderForTests(async () => ({ admin: null, hkcu: null }));
    clearProjectPathCache();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    delete process.env["CLAUDE_CONFIG_DIR"];
    delete process.env["CLAUDE_CODE_MANAGED_SETTINGS_PATH"];
    for (const key of ISOLATED_ENV_KEYS) delete process.env[key];
    setMdmReaderForTests(null);
  });

  it("lists projects discovered under ~/.claude/projects/, newest first by per-file mtime", async () => {
    const a = join(projectsRoot, "A-proj-a", "memory");
    const b = join(projectsRoot, "B-proj-b", "memory");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await writeFile(join(a, "old.md"), "old", "utf8");
    // 少し時間を空けて b に新しいファイルを置く。
    await new Promise((r) => setTimeout(r, 25));
    await writeFile(join(b, "newer.md"), "new", "utf8");

    const projects = await listProjects();
    expect(projects.length).toBe(2);
    expect(projects[0]?.name).toBe("B-proj-b");
    expect(projects[1]?.name).toBe("A-proj-a");
  });

  it("listFiles returns headers from .md files but skips MEMORY.md (which is the index)", async () => {
    const dir = join(projectsRoot, "P", "memory");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "user_role.md"),
      "---\nname: role\ndescription: user is a SRE\ntype: user\n---\nbody",
      "utf8",
    );
    await writeFile(join(dir, "MEMORY.md"), "- intro\n", "utf8");

    const headers = await listFiles(`${dir}/`);
    expect(headers).toHaveLength(1);
    expect(headers[0]?.filename).toBe("user_role.md");
    expect(headers[0]?.name).toBe("role");
    expect(headers[0]?.type).toBe("user");
  });

  it("listFiles preserves nested MEMORY.md (e.g. team/MEMORY.md) — only the top-level index is hidden", async () => {
    const dir = join(projectsRoot, "PT", "memory");
    const team = join(dir, "team");
    await mkdir(team, { recursive: true });
    await writeFile(join(dir, "MEMORY.md"), "- main index\n", "utf8");
    await writeFile(join(team, "MEMORY.md"), "- team index\n", "utf8");
    await writeFile(join(team, "rule.md"), "team rule body", "utf8");

    const headers = await listFiles(`${dir}/`);
    const names = headers.map((h) => h.filename).sort();
    // team/MEMORY.md (nested) と team/rule.md は残り、 top-level MEMORY.md だけ落ちる。
    expect(names).toEqual(["team/MEMORY.md", "team/rule.md"]);
  });

  it("listFiles caps at MAX_MEMORY_FILES even when more files exist", async () => {
    const dir = join(projectsRoot, "Q", "memory");
    await mkdir(dir, { recursive: true });
    const total = MEMORY_CONSTANTS.MAX_MEMORY_FILES + 5;
    await Promise.all(
      Array.from({ length: total }, (_, i) =>
        writeFile(join(dir, `f${String(i).padStart(4, "0")}.md`), `body ${String(i)}`, "utf8"),
      ),
    );
    const headers = await listFiles(`${dir}/`);
    expect(headers.length).toBe(MEMORY_CONSTANTS.MAX_MEMORY_FILES);
  });

  it("hasIndex is true only for a top-level MEMORY.md, not a nested team/MEMORY.md", async () => {
    const nestedOnly = join(projectsRoot, "N-nested", "memory");
    await mkdir(join(nestedOnly, "team"), { recursive: true });
    await writeFile(join(nestedOnly, "team", "MEMORY.md"), "- t\n", "utf8");
    const topLevel = join(projectsRoot, "T-top", "memory");
    await mkdir(topLevel, { recursive: true });
    await writeFile(join(topLevel, "MEMORY.md"), "- i\n", "utf8");

    const projects = await listProjects();
    const nested = projects.find((p) => p.name === "N-nested");
    const top = projects.find((p) => p.name === "T-top");
    expect(nested?.hasIndex).toBe(false);
    expect(top?.hasIndex).toBe(true);
  });

  it("search truncated flag ignores non-.md entries", async () => {
    const dir = join(projectsRoot, "SRCH", "memory");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "one.md"), "needle here\n", "utf8");
    // .md でない大量の entry があっても truncated にはならない。
    await Promise.all(
      Array.from({ length: 510 }, (_, i) =>
        writeFile(join(dir, `noise-${String(i)}.txt`), "needle\n", "utf8"),
      ),
    );
    const res = await search(`${dir}/`, "needle");
    expect(res.truncated).toBe(false);
    expect(res.hits.length).toBe(1);
    expect(res.scanned).toBe(1);
  });

  it("lastModifiedMs reflects deletions via the directory mtime (max of dir and file mtimes)", async () => {
    const dir = join(projectsRoot, "MT", "memory");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "keep.md"), "keep\n", "utf8");
    await writeFile(join(dir, "gone.md"), "gone\n", "utf8");
    // ファイル作成より後に削除を起こし、 dir mtime だけが進む状況を作る。
    await new Promise((r) => setTimeout(r, 25));
    await deleteFile(join(dir, "gone.md"));

    const projects = await listProjects();
    const project = projects.find((p) => p.name === "MT");
    const { stat } = await import("node:fs/promises");
    const keepMtime = (await stat(join(dir, "keep.md"))).mtimeMs;
    // 残存ファイルの mtime は削除前のまま。 削除で進んだ dir mtime が MAX に
    // 反映されるので lastModifiedMs はそれより新しい。
    expect(project?.lastModifiedMs).toBeGreaterThan(keepMtime);
  });

  it("deleteFile blocks the top-level MEMORY.md but allows nested team/MEMORY.md", async () => {
    const dir = join(projectsRoot, "DEL", "memory");
    await mkdir(join(dir, "team"), { recursive: true });
    await writeFile(join(dir, "MEMORY.md"), "- index\n", "utf8");
    await writeFile(join(dir, "team", "MEMORY.md"), "- team index\n", "utf8");

    await expect(deleteFile(join(dir, "MEMORY.md"))).rejects.toThrow(/cannot be deleted/);
    // listFiles が通常ファイルとして出すネスト index は削除できる。
    await deleteFile(join(dir, "team", "MEMORY.md"));
    const headers = await listFiles(`${dir}/`);
    expect(headers.map((h) => h.filename)).toEqual([]);
  });

  it("readIndex measures limits on the loaded content (frontmatter/comments stripped)", async () => {
    const dir = join(projectsRoot, "IDX", "memory");
    await mkdir(dir, { recursive: true });
    const frontmatter = "---\nmodified: 2026-08-01T00:00:00Z\n---\n";
    const comment = "<!-- managed by claude -->\n\n";
    const body = Array.from({ length: 200 }, (_, i) => `- e${String(i)}`).join("\n");
    const raw = frontmatter + comment + body;
    await writeFile(join(dir, "MEMORY.md"), raw, "utf8");

    const idx = await readIndex(`${dir}/`);
    expect(idx.exists).toBe(true);
    // raw はそのまま返しつつ、 測定は strip 後の内容に対して行われる。
    expect(idx.content).toBe(raw);
    expect(idx.lineCount).toBe(200);
    expect(idx.wasLineTruncated).toBe(false);
    expect(idx.loadedContent).not.toContain("modified:");
    expect(idx.loadedContent).not.toContain("managed by claude");
  });

  it("lists a custom autoMemoryDirectory outside projects root as a virtual project with per-file mtime", async () => {
    const custom = join(home, "custom-mem");
    await mkdir(custom, { recursive: true });
    await writeFile(join(custom, "MEMORY.md"), "- idx\n", "utf8");
    await writeFile(join(custom, "notes.md"), "n\n", "utf8");
    process.env["CLAUDE_COWORK_MEMORY_PATH_OVERRIDE"] = custom;
    try {
      const projects = await listProjects();
      const virtual = projects.find((p) => p.name.startsWith("(custom)"));
      expect(virtual).toBeDefined();
      // MEMORY.md は index として別に数える (catalog の件数と揃える)。
      expect(virtual?.fileCount).toBe(1);
      expect(virtual?.hasIndex).toBe(true);
      // dir 自体の mtime ではなくファイル mtime の MAX が使われる。
      expect(virtual?.lastModifiedMs).toBeGreaterThan(0);
    } finally {
      delete process.env["CLAUDE_COWORK_MEMORY_PATH_OVERRIDE"];
    }
  });

  it("createFile is atomic (rejects with 'already exists' on second call)", async () => {
    const dir = `${join(projectsRoot, "R", "memory")}/`;
    await createFile({
      memoryDir: dir,
      filename: "user_a",
      frontmatter: { name: "a", description: "first", type: "user" },
      body: "body 1\n",
    });
    await expect(
      createFile({
        memoryDir: dir,
        filename: "user_a",
        frontmatter: { name: "a", description: "dup", type: "user" },
        body: "body 2\n",
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("createFile blocks MEMORY.md and path separators", async () => {
    const dir = `${join(projectsRoot, "S", "memory")}/`;
    await expect(
      createFile({
        memoryDir: dir,
        filename: "MEMORY.md",
        frontmatter: { name: "x", description: "y", type: "user" },
        body: "",
      }),
    ).rejects.toThrow(/MEMORY\.md/);
    await expect(
      createFile({
        memoryDir: dir,
        filename: "sub/dir.md",
        frontmatter: { name: "x", description: "y", type: "user" },
        body: "",
      }),
    ).rejects.toThrow(/path separators/);
    // Windows で無効な文字は fs の cryptic なエラーになる前に明示的に弾く。
    await expect(
      createFile({
        memoryDir: dir,
        filename: "bad:name.md",
        frontmatter: { name: "x", description: "y", type: "user" },
        body: "",
      }),
    ).rejects.toThrow(/invalid on Windows/);
    // 予約デバイス名は拡張子付きでも invalid (CON.md / com1.md)。
    await Promise.all(
      ["CON", "nul.md", "com1", "COM¹.md", "lpt³"].map((reserved) =>
        expect(
          createFile({
            memoryDir: dir,
            filename: reserved,
            frontmatter: { name: "x", description: "y", type: "user" },
            body: "",
          }),
        ).rejects.toThrow(/reserved device name/),
      ),
    );
    // 予約名を含むだけの通常名は通る (console.md など)。
    const ok = await createFile({
      memoryDir: dir,
      filename: "console-notes",
      frontmatter: { name: "x", description: "y", type: "user" },
      body: "",
    });
    expect(ok.filename).toBe("console-notes.md");
  });

  it("resolveProjectForPath resolves relative inputs against cwd", async () => {
    // renderer は cwd バッジのために "." を投げてくる。 相対 path が
    // 絶対化されずに常に null になっていた regression を防ぐ。
    const abs = await resolveProjectForPath(resolve("."));
    const rel = await resolveProjectForPath(".");
    // プロジェクトが存在するかどうかは環境依存だが、 絶対/相対で同じ結論に
    // なること (= 相対でも解決が走ること) だけを固定する。
    expect(rel === null).toBe(abs === null);
    if (rel !== null && abs !== null) {
      expect(rel.name).toBe(abs.name);
    }
  });

  it("rejects paths outside the projects root (guard)", async () => {
    const escape = `${tmpdir()}/elsewhere/`;
    await expect(listFiles(escape)).rejects.toThrow(/Not an auto memory directory/);
  });

  it("resolveProjectForPath uses sanitized canonical root for lookup", async () => {
    // 適当なパス -> sanitize -> projectsRoot/<sanitized> を探しに行く動きを検証。
    const fake = join(home, "workspace", "myproj");
    await mkdir(fake, { recursive: true });
    // sanitizePath は非英数字を `-` に変換するので、 ファイルツリーをそれに合わせて
    // 作る。
    const sanitized = fake.replace(/[^a-zA-Z0-9]/g, "-");
    const memoryDir = join(projectsRoot, sanitized, "memory");
    await mkdir(memoryDir, { recursive: true });
    await writeFile(join(memoryDir, "x.md"), "hello", "utf8");

    const project = await resolveProjectForPath(fake);
    expect(project).not.toBeNull();
    expect(project?.fileCount).toBe(1);
  });

  /**
   * 長 path (>200 char) の prefix 一致テスト用 fixture。
   *
   * resolveProjectForPath は入力を resolve() で絶対化してから sanitize する。
   * Windows では "/aaa..." がドライブレター付き ("D:\\aaa..." 等) に解決されて
   * sanitized prefix が "-aaa..." ではなく "D--aaa..." になるため、 prefix を
   * POSIX 前提でハードコードするとリリースビルド (windows-latest) だけ落ちる。
   * 実装 (findProjectDirEntry) と同じ経路 resolve → sanitizePath → 200 char
   * slice で prefix を導出し、 platform 差を吸収する。
   */
  function longPathFixture(ch: string): { longPath: string; prefix: string } {
    const { MAX_SANITIZED_LENGTH } = MEMORY_CONSTANTS;
    const longPath = resolve("/" + ch.repeat(MAX_SANITIZED_LENGTH + 50));
    const sanitized = sanitizePath(longPath);
    expect(sanitized.length).toBeGreaterThan(MAX_SANITIZED_LENGTH);
    return { longPath, prefix: sanitized.slice(0, MAX_SANITIZED_LENGTH) };
  }

  it("resolveProjectForPath returns null when two long paths share the 200-char prefix (ambiguous)", async () => {
    // 200 char を超える sanitized 値を作り、 異なる hash 接尾辞を持つ 2 ディレクトリ
    // を projectsRoot に並べる。 「最初の一致」を返してしまうと正答が偶然依存になる
    // ので、 こうした衝突時は null を返すべき。
    const { longPath, prefix } = longPathFixture("a");
    const a = join(projectsRoot, `${prefix}-hashA`, "memory");
    const b = join(projectsRoot, `${prefix}-hashB`, "memory");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await writeFile(join(a, "x.md"), "x", "utf8");
    await writeFile(join(b, "y.md"), "y", "utf8");

    const project = await resolveProjectForPath(longPath);
    expect(project).toBeNull();
  });

  it("resolveProjectForPath resolves via prefix when only one long-path candidate exists", async () => {
    const { longPath, prefix } = longPathFixture("b");
    const dir = join(projectsRoot, `${prefix}-soleHash`, "memory");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "x.md"), "x", "utf8");

    const project = await resolveProjectForPath(longPath);
    expect(project).not.toBeNull();
    expect(project?.fileCount).toBe(1);
  });

  it("renameFile renames within the same directory and returns the new path", async () => {
    const dir = join(projectsRoot, "RN", "memory");
    await mkdir(dir, { recursive: true });
    const src = join(dir, "old_name.md");
    await writeFile(src, "body", "utf8");

    // `.md` は省略可能 (createFile と同じ補完規則)。
    const renamed = await renameFile(src, "new_name");
    expect(renamed.path).toBe(join(dir, "new_name.md"));
    expect(renamed.indexLinksUpdated).toBe(0);

    const headers = await listFiles(`${dir}/`);
    expect(headers.map((h) => h.filename)).toEqual(["new_name.md"]);
  });

  it("renameFile blocks invalid targets (separators, invalid chars, reserved, MEMORY.md)", async () => {
    const dir = join(projectsRoot, "RNV", "memory");
    await mkdir(dir, { recursive: true });
    const src = join(dir, "keep.md");
    await writeFile(src, "body", "utf8");

    await expect(renameFile(src, "sub/dir.md")).rejects.toThrow(/path separators/);
    await expect(renameFile(src, "bad:name")).rejects.toThrow(/invalid on Windows/);
    await expect(renameFile(src, "con")).rejects.toThrow(/reserved device name/);
    await expect(renameFile(src, "MEMORY.md")).rejects.toThrow(/writeIndex/);
    await expect(renameFile(src, "   ")).rejects.toThrow(/empty/);
    // すべて拒否された後も元ファイルは無傷。
    const headers = await listFiles(`${dir}/`);
    expect(headers.map((h) => h.filename)).toEqual(["keep.md"]);
  });

  it("renameFile refuses to overwrite an existing file", async () => {
    const dir = join(projectsRoot, "RNO", "memory");
    await mkdir(dir, { recursive: true });
    const a = join(dir, "a.md");
    const b = join(dir, "b.md");
    await writeFile(a, "a", "utf8");
    await writeFile(b, "b", "utf8");

    await expect(renameFile(a, "b.md")).rejects.toThrow(/already exists/);
  });

  it("renameFile blocks the top-level MEMORY.md but allows a nested team/MEMORY.md", async () => {
    const dir = join(projectsRoot, "RNI", "memory");
    await mkdir(join(dir, "team"), { recursive: true });
    await writeFile(join(dir, "MEMORY.md"), "- index\n", "utf8");
    await writeFile(join(dir, "team", "MEMORY.md"), "- team\n", "utf8");

    await expect(renameFile(join(dir, "MEMORY.md"), "renamed")).rejects.toThrow(
      /cannot be renamed/,
    );
    // ネストした MEMORY.md は listFiles 上は通常ファイルなので rename できる。
    const renamed = await renameFile(join(dir, "team", "MEMORY.md"), "archive");
    expect(renamed.path).toBe(join(dir, "team", "archive.md"));
  });

  it("searchAll aggregates hits across projects with project labels", async () => {
    const a = join(projectsRoot, "GA", "memory");
    const b = join(projectsRoot, "GB", "memory");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await writeFile(join(a, "one.md"), "shared needle in A\n", "utf8");
    await writeFile(join(b, "two.md"), "shared needle in B\nagain needle\n", "utf8");
    await writeFile(join(b, "miss.md"), "nothing here\n", "utf8");

    const res = await searchAll("needle");
    expect(res.scannedProjects).toBe(2);
    expect(res.hits.length).toBe(3);
    const byProject = new Set(res.hits.map((h) => h.projectName));
    expect(byProject).toEqual(new Set(["GA", "GB"]));
    for (const hit of res.hits) {
      expect(hit.memoryDir.length).toBeGreaterThan(0);
      expect(hit.projectLabel.length).toBeGreaterThan(0);
    }
  });

  it("searchAll returns an empty result for a blank query without scanning", async () => {
    const res = await searchAll("   ");
    expect(res.hits).toEqual([]);
    expect(res.scannedProjects).toBe(0);
    expect(res.truncated).toBe(false);
  });

  it("searchAll includes the virtual custom autoMemoryDirectory project", async () => {
    const custom = join(home, "custom-mem");
    await mkdir(custom, { recursive: true });
    await writeFile(join(custom, "notes.md"), "custom needle\n", "utf8");
    process.env["CLAUDE_COWORK_MEMORY_PATH_OVERRIDE"] = custom;
    try {
      const res = await searchAll("needle");
      expect(res.hits.length).toBe(1);
      expect(res.hits[0]?.projectName.startsWith("(custom)")).toBe(true);
    } finally {
      delete process.env["CLAUDE_COWORK_MEMORY_PATH_OVERRIDE"];
    }
  });
  async function memoryDirFor(name: string): Promise<string> {
    const dir = join(projectsRoot, name, "memory");
    await mkdir(dir, { recursive: true });
    return dir;
  }

  it("listFiles reads descriptions containing ': ' and the modified timestamp", async () => {
    const dir = await memoryDirFor("HDR");
    await writeFile(
      join(dir, "feedback_db.md"),
      [
        "---",
        "name: DB tests",
        "description: Testing policy: integration tests must hit a real DB",
        "type: feedback",
        "modified: 2026-07-18T10:00:00.000Z",
        "---",
        "body",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(dir, "broken.md"), "---\nkey: : bad : :\n  - x\n---\nbody", "utf8");
    const headers = await listFiles(`${dir}/`);
    const db = headers.find((h) => h.filename === "feedback_db.md");
    expect(db?.description).toBe("Testing policy: integration tests must hit a real DB");
    expect(db?.type).toBe("feedback");
    expect(db?.modifiedMs).toBe(Date.UTC(2026, 6, 18, 10));
    expect(db?.frontmatterInvalid).toBe(false);
    const broken = headers.find((h) => h.filename === "broken.md");
    expect(broken?.frontmatterInvalid).toBe(true);
    expect(broken?.modifiedMs).toBeNull();
  });

  it("writeFile stamps `modified` on files with frontmatter only", async () => {
    const dir = await memoryDirFor("STAMP");
    const withFm = join(dir, "a.md");
    const plain = join(dir, "b.md");
    await writeFile(withFm, "---\nname: a\n---\nold", "utf8");
    await writeFile(plain, "old", "utf8");
    const before = Date.now();

    expect(
      await writeMemoryFile(withFm, "---\nname: a\n---\nnew", {
        content: "---\nname: a\n---\nold",
      }),
    ).toEqual({ status: "saved" });
    expect(await writeMemoryFile(plain, "new", { content: "old" })).toEqual({ status: "saved" });

    const stamped = await readMemoryFile(withFm);
    expect(stamped.body).toBe("new");
    expect(stamped.modifiedMs).not.toBeNull();
    expect(stamped.modifiedMs ?? 0).toBeGreaterThanOrEqual(before - 1000);
    expect(await readFile(plain, "utf8")).toBe("new");
  });

  it("writeFile refuses to overwrite a file changed on disk since it was opened", async () => {
    const dir = await memoryDirFor("CONFLICT");
    const file = join(dir, "c.md");
    await writeFile(file, "original", "utf8");
    // Claude Code が並行して書き換えた。
    await writeFile(file, "changed by claude", "utf8");

    const result = await writeMemoryFile(file, "my edit", { content: "original" });
    expect(result).toEqual({ status: "conflict", current: "changed by claude" });
    expect(await readFile(file, "utf8")).toBe("changed by claude");

    // ユーザが「上書き」を選んだら検査せずに書く。
    expect(await writeMemoryFile(file, "my edit", null)).toEqual({ status: "saved" });
    expect(await readFile(file, "utf8")).toBe("my edit");
  });

  it("writeFile reports a deleted file as a conflict with current=null", async () => {
    const dir = await memoryDirFor("GONE");
    const file = join(dir, "gone.md");
    const result = await writeMemoryFile(file, "edit", { content: "was here" });
    expect(result).toEqual({ status: "conflict", current: null });
  });

  it("writeFile keeps CRLF line endings of the file on disk", async () => {
    const dir = await memoryDirFor("CRLF");
    const file = join(dir, "w.md");
    await writeFile(file, "line 1\r\nline 2\r\n", "utf8");
    // textarea は LF に正規化した値を返す。
    await writeMemoryFile(file, "line 1\nline 2 edited\n", { content: "line 1\r\nline 2\r\n" });
    expect(await readFile(file, "utf8")).toBe("line 1\r\nline 2 edited\r\n");
  });

  it("writeIndex detects an index created by someone else while editing a missing one", async () => {
    const dir = await memoryDirFor("IDXNEW");
    await writeFile(join(dir, "MEMORY.md"), "- [x](x.md) — from claude\n", "utf8");
    const result = await writeIndex(`${dir}/`, "- mine\n", { content: null });
    expect(result.status).toBe("conflict");
    const saved = await writeIndex(`${dir}/`, "- mine\n", {
      content: "- [x](x.md) — from claude\n",
    });
    expect(saved).toEqual({ status: "saved" });
  });

  it("createFile writes `modified` and can add the official index pointer", async () => {
    const dir = await memoryDirFor("CREATE");
    await writeFile(join(dir, "MEMORY.md"), "# Index\n- [old](old.md) — kept", "utf8");
    const header = await createFile({
      memoryDir: `${dir}/`,
      filename: "user_role",
      frontmatter: {
        name: "User role",
        description: "senior Go engineer, new to React",
        type: "user",
      },
      body: "Deep Go experience.\n",
      addToIndex: true,
    });
    expect(header.filename).toBe("user_role.md");
    expect(header.modifiedMs).not.toBeNull();
    const index = await readFile(join(dir, "MEMORY.md"), "utf8");
    expect(index).toBe(
      "# Index\n- [old](old.md) — kept\n- [User role](user_role.md) — senior Go engineer, new to React\n",
    );
  });

  it("createFile creates MEMORY.md when adding the first pointer", async () => {
    const dir = await memoryDirFor("CREATE2");
    await createFile({
      memoryDir: `${dir}/`,
      filename: "my notes",
      frontmatter: { name: "Notes [draft]", description: "multi\nline", type: "project" },
      body: "",
      addToIndex: true,
    });
    expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toBe(
      "- [Notes \\[draft\\]](<my notes.md>) — multi line\n",
    );
  });

  it("createFile rejects names Windows would silently rename (trailing dot or space)", async () => {
    const dir = await memoryDirFor("TRAIL");
    await expect(
      createFile({
        memoryDir: `${dir}/`,
        filename: "draft.",
        frontmatter: { name: "x", description: "y", type: "user" },
        body: "",
      }),
    ).rejects.toThrow(/dot or a space/);
  });

  it("renameFile can retarget MEMORY.md links (anchors and ./ kept)", async () => {
    const dir = await memoryDirFor("RNL");
    await writeFile(join(dir, "old.md"), "body", "utf8");
    await writeFile(
      join(dir, "MEMORY.md"),
      "- [Old](old.md) — hook\n- [Again](./old.md#why)\n- [Other](other.md)\n",
      "utf8",
    );
    const result = await renameFile(join(dir, "old.md"), "new name", { updateIndexLinks: true });
    expect(result.indexLinksUpdated).toBe(2);
    expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toBe(
      "- [Old](<new name.md>) — hook\n- [Again](<./new name.md#why>)\n- [Other](other.md)\n",
    );
  });

  it("deleteFile can drop index entries that point only at the deleted memory", async () => {
    const dir = await memoryDirFor("DELIDX");
    await writeFile(join(dir, "gone.md"), "body", "utf8");
    await writeFile(join(dir, "keep.md"), "body", "utf8");
    await writeFile(
      join(dir, "MEMORY.md"),
      "# Index\n- [Gone](gone.md) — stale\n- [Keep](keep.md)\n- [Both](gone.md) vs [keep](keep.md)\n",
      "utf8",
    );
    const result = await deleteFile(join(dir, "gone.md"), { removeIndexEntries: true });
    expect(result).toEqual({ indexEntriesRemoved: 1, indexError: null });
    expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toBe(
      "# Index\n- [Keep](keep.md)\n- [Both](gone.md) vs [keep](keep.md)\n",
    );
  });

  it("reports an index it could not update instead of failing a finished rename or delete", async () => {
    const dir = await memoryDirFor("IDXFAIL");
    await writeFile(join(dir, "a.md"), "body", "utf8");
    await writeFile(join(dir, "b.md"), "body", "utf8");
    // MEMORY.md を読めない形 (ディレクトリ) にして index の書き換えを失敗させる。
    await mkdir(join(dir, "MEMORY.md"));

    const renamed = await renameFile(join(dir, "a.md"), "c", { updateIndexLinks: true });
    expect(renamed).toMatchObject({ path: join(dir, "c.md"), indexLinksUpdated: 0 });
    expect(renamed.indexError).toEqual(expect.any(String));
    expect(await readFile(join(dir, "c.md"), "utf8")).toBe("body");

    const deleted = await deleteFile(join(dir, "b.md"), { removeIndexEntries: true });
    expect(deleted.indexError).toEqual(expect.any(String));
    await expect(readFile(join(dir, "b.md"), "utf8")).rejects.toThrow();
  });

  it("lists the configured autoMemoryDirectory under projects/ even before it exists", async () => {
    // projects/<name>/memory の形の設定先は通常のプロジェクトとして出すが、 まだ
    // 作られていないと通常の走査には現れない。
    process.env["CLAUDE_COWORK_MEMORY_PATH_OVERRIDE"] = join(projectsRoot, "-planned", "memory");
    const listed = (await listProjects()).filter((p) => p.name === "-planned");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ kind: "project", fileCount: 0, hasIndex: false });
    expect((await resolveProjectForPath("."))?.name).toBe("-planned");
  });

  it("readIndex reports index health (dangling links, orphans, long entries, frontmatter)", async () => {
    const dir = await memoryDirFor("HEALTH");
    await writeFile(join(dir, "linked.md"), "x", "utf8");
    await writeFile(join(dir, "orphan.md"), "x", "utf8");
    const long = `- [Linked](linked.md) — ${"detail ".repeat(40)}`;
    await writeFile(
      join(dir, "MEMORY.md"),
      ["---", "note: no frontmatter please", "---", long, "- [Missing](missing.md)", ""].join("\n"),
      "utf8",
    );
    const idx = await readIndex(`${dir}/`);
    expect(idx.health.hasFrontmatter).toBe(true);
    expect(idx.health.danglingLinks).toEqual([{ line: 5, target: "missing.md" }]);
    expect(idx.health.orphans).toEqual(["orphan.md"]);
    expect(idx.health.linkedFiles).toEqual(["linked.md"]);
    expect(idx.health.longEntries).toHaveLength(1);
    expect(idx.health.longEntries[0]?.line).toBe(4);
  });

  it("readIndex returns the cut-off part separately when the index is over the limit", async () => {
    const dir = await memoryDirFor("CUT");
    const lines = Array.from({ length: 205 }, (_, i) => `- e${String(i)}`);
    await writeFile(join(dir, "MEMORY.md"), lines.join("\n"), "utf8");
    const idx = await readIndex(`${dir}/`);
    expect(idx.wasLineTruncated).toBe(true);
    expect(idx.loadedLineCount).toBe(200);
    expect(idx.droppedContent).toBe(lines.slice(200).join("\n"));
    expect(idx.loadedContent).not.toContain("WARNING");
  });

  it("lists user-scope subagent memory under <base>/agent-memory and guards it", async () => {
    const agentDir = join(home, "agent-memory", "code-reviewer");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "MEMORY.md"), "- [p](patterns.md)\n", "utf8");
    await writeFile(join(agentDir, "patterns.md"), "---\nname: p\ntype: reference\n---\n", "utf8");

    const projects = await listProjects();
    const agent = projects.find((p) => p.kind === "agent");
    expect(agent?.name).toBe("agent:code-reviewer");
    expect(agent?.displayName).toBe("code-reviewer");
    expect(agent?.hasIndex).toBe(true);
    const files = await listFiles(agent?.memoryDir ?? "");
    expect(files.map((f) => f.filename)).toEqual(["patterns.md"]);
    await expect(deleteFile(join(agentDir, "MEMORY.md"))).rejects.toThrow(/cannot be deleted/);
    const hits = await searchAll("patterns");
    expect(hits.hits.some((h) => h.projectName === "agent:code-reviewer")).toBe(true);
  });

  it("decodes the project path from session transcripts when the cwd matches", async () => {
    const realPath = resolve("/work/my-app.v2");
    const name = sanitizePath(realPath);
    const projectDir = join(projectsRoot, name);
    await mkdir(join(projectDir, "memory"), { recursive: true });
    await writeFile(
      join(projectDir, "0c9f.jsonl"),
      `${JSON.stringify({ type: "summary", summary: "x" })}\n${JSON.stringify({ cwd: realPath, sessionId: "s" })}\n`,
      "utf8",
    );
    const project = (await listProjects()).find((p) => p.name === name);
    expect(project?.decodedProjectPath).toBe(realPath);
    expect(project?.projectPathSource).toBe("transcript");
  });

  it("falls back to the guessed path when no transcript matches", async () => {
    await memoryDirFor("-home-me-repo");
    const project = (await listProjects()).find((p) => p.name === "-home-me-repo");
    expect(project?.decodedProjectPath).toBe("/home/me/repo");
    expect(project?.projectPathSource).toBe("guess");
  });

  it("resolveProjectForPath honors CLAUDE_CODE_PROJECT_DIR_NAME", async () => {
    await memoryDirFor("work");
    process.env["CLAUDE_CODE_PROJECT_DIR_NAME"] = "work";
    const project = await resolveProjectForPath("/anywhere/at/all");
    expect(project?.name).toBe("work");
  });

  it("resolveProjectForPath points at the custom directory when autoMemoryDirectory is set", async () => {
    const custom = join(home, "custom-mem");
    await mkdir(custom, { recursive: true });
    process.env["CLAUDE_COWORK_MEMORY_PATH_OVERRIDE"] = custom;
    const project = await resolveProjectForPath(".");
    expect(project?.kind).toBe("custom");
    expect(project?.name.startsWith("(custom)")).toBe(true);
  });

  it("readHeader works for files outside the 200-file listing window", async () => {
    const dir = await memoryDirFor("RH");
    await mkdir(join(dir, "team"), { recursive: true });
    await writeFile(join(dir, "team", "t.md"), "---\nname: team note\n---\n", "utf8");
    const header = await readHeader(join(dir, "team", "t.md"));
    expect(header.filename).toBe("team/t.md");
    expect(header.name).toBe("team note");
  });

  it("search excerpts stay aligned around characters that change length when lowercased", async () => {
    const dir = await memoryDirFor("UNI");
    // "İ".toLowerCase() は 2 code unit になるので、 小文字化した行で位置を取ると
    // 抜粋の窓が needle から外れていた。
    await writeFile(join(dir, "u.md"), `${"İ".repeat(100)}NEEDLE${"x".repeat(100)}`, "utf8");
    const res = await search(`${dir}/`, "needle");
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]?.excerpt).toContain("NEEDLE");
  });

  it("only accepts memory directories and .md files inside them", async () => {
    const dir = await memoryDirFor("G");
    const agentDir = join(home, "agent-memory", "reviewer");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(projectsRoot, "G", "s1.jsonl"), "{}\n", "utf8");

    // root 配下でも memory ディレクトリ外 / .md 以外は書けない・消せない・開けない。
    await expect(writeMemoryFile(join(projectsRoot, "payload.bat"), "x", null)).rejects.toThrow(
      /Not a memory file/,
    );
    await expect(writeMemoryFile(join(agentDir, "run.cmd"), "x", null)).rejects.toThrow(
      /Not a memory file/,
    );
    await expect(deleteFile(join(projectsRoot, "G", "s1.jsonl"))).rejects.toThrow(
      /Not a memory file/,
    );
    await expect(revealInEditor(join(dir, "x.bat"))).rejects.toThrow(/Not a memory file/);
    await expect(
      createFile({
        memoryDir: projectsRoot,
        filename: "x",
        frontmatter: { name: "x", description: "y", type: "user" },
        body: "",
      }),
    ).rejects.toThrow(/Not an auto memory directory/);
    await expect(listFiles(projectsRoot)).rejects.toThrow(/Not an auto memory directory/);
    await expect(readIndex(join(home, "agent-memory"))).rejects.toThrow(
      /Not an auto memory directory/,
    );

    // memory ディレクトリそのもの (末尾の区切り文字付きも) とその中の .md は通る。
    await expect(listFiles(`${dir}/`)).resolves.toEqual([]);
    await expect(readIndex(agentDir)).resolves.toMatchObject({ exists: false });
    await expect(writeMemoryFile(join(agentDir, "note.md"), "n\n", null)).resolves.toEqual({
      status: "saved",
    });
  });

  it("renameFile never replaces a different file, whatever the platform claims", async () => {
    const dir = await memoryDirFor("CASE");
    await writeFile(join(dir, "Foo.md"), "UPPER\n", "utf8");
    await writeFile(join(dir, "foo.md"), "LOWER - precious\n", "utf8");
    // case-insensitive な fs (既定の macOS / Windows) では 2 つ目の書き込みが同じ
    // ファイルに当たる。 そのときの Foo.md → foo は大文字小文字だけの rename。
    const distinctFiles = (await readFile(join(dir, "Foo.md"), "utf8")) === "UPPER\n";
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    // OS 名ではなく実際の fs で判定することを確かめるため、 platform は macOS を装う
    // (case-sensitive な APFS ボリュームの macOS が別ファイルを潰していた)。
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const rename = renameFile(join(dir, "Foo.md"), "foo");
      await (distinctFiles
        ? expect(rename).rejects.toThrow(/already exists/)
        : expect(rename).resolves.toMatchObject({ path: join(dir, "foo.md") }));
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
    }
    expect(await readFile(join(dir, "foo.md"), "utf8")).toBe("LOWER - precious\n");
  });

  it("rejects new filenames that would break index links or end up empty", async () => {
    const dir = await memoryDirFor("FN");
    const req = (filename: string) => ({
      memoryDir: dir,
      filename,
      frontmatter: { name: "n", description: "d", type: "user" as const },
      body: "",
    });
    await expect(createFile(req("c#-tips"))).rejects.toThrow(/# or %/);
    await expect(createFile(req("a%41"))).rejects.toThrow(/# or %/);
    await expect(createFile(req("   "))).rejects.toThrow(/empty/);
    await writeFile(join(dir, "ok.md"), "x\n", "utf8");
    await expect(renameFile(join(dir, "ok.md"), "c#")).rejects.toThrow(/# or %/);
  });
});
