import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MEMORY_CONSTANTS } from "@shared/schema/memory.ts";

import {
  createFile,
  deleteFile,
  listFiles,
  listProjects,
  readIndex,
  resolveProjectForPath,
  search,
} from "../memory.ts";

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
    delete process.env["CLAUDE_CODE_REMOTE_MEMORY_DIR"];
    delete process.env["CLAUDE_COWORK_MEMORY_PATH_OVERRIDE"];
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    delete process.env["CLAUDE_CONFIG_DIR"];
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
        writeFile(
          join(dir, `f${String(i).padStart(4, "0")}.md`),
          `body ${String(i)}`,
          "utf8",
        ),
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

  it("deleteFile blocks the top-level MEMORY.md but allows nested team/MEMORY.md", async () => {
    const dir = join(projectsRoot, "DEL", "memory");
    await mkdir(join(dir, "team"), { recursive: true });
    await writeFile(join(dir, "MEMORY.md"), "- index\n", "utf8");
    await writeFile(join(dir, "team", "MEMORY.md"), "- team index\n", "utf8");

    await expect(deleteFile(join(dir, "MEMORY.md"))).rejects.toThrow(
      /cannot be deleted/,
    );
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
    const body = Array.from({ length: 200 }, (_, i) => `- e${String(i)}`).join(
      "\n",
    );
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
      expect(virtual?.fileCount).toBe(2);
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
      ["CON", "nul.md", "com1"].map((reserved) =>
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
    const { resolve } = await import("node:path");
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
    await expect(listFiles(escape)).rejects.toThrow(/escapes allowed/);
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

  it("resolveProjectForPath returns null when two long paths share the 200-char prefix (ambiguous)", async () => {
    // 200 char を超える sanitized 値を作り、 異なる hash 接尾辞を持つ 2 ディレクトリ
    // を projectsRoot に並べる。 「最初の一致」を返してしまうと正答が偶然依存になる
    // ので、 こうした衝突時は null を返すべき。
    //
    // sanitizePath は非英数字を `-` に変換するため、 path 先頭 `/` も `-` になる。
    // 200 char までの prefix は `-` + `a` * 199 になる前提で directory 名を作る。
    const { MAX_SANITIZED_LENGTH } = MEMORY_CONSTANTS;
    const prefix = "-" + "a".repeat(MAX_SANITIZED_LENGTH - 1);
    const a = join(projectsRoot, `${prefix}-hashA`, "memory");
    const b = join(projectsRoot, `${prefix}-hashB`, "memory");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await writeFile(join(a, "x.md"), "x", "utf8");
    await writeFile(join(b, "y.md"), "y", "utf8");

    const longPath = "/" + "a".repeat(MAX_SANITIZED_LENGTH + 50);
    const project = await resolveProjectForPath(longPath);
    expect(project).toBeNull();
  });

  it("resolveProjectForPath resolves via prefix when only one long-path candidate exists", async () => {
    const { MAX_SANITIZED_LENGTH } = MEMORY_CONSTANTS;
    const prefix = "-" + "b".repeat(MAX_SANITIZED_LENGTH - 1);
    const dir = join(projectsRoot, `${prefix}-soleHash`, "memory");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "x.md"), "x", "utf8");

    const longPath = "/" + "b".repeat(MAX_SANITIZED_LENGTH + 50);
    const project = await resolveProjectForPath(longPath);
    expect(project).not.toBeNull();
    expect(project?.fileCount).toBe(1);
  });
});
