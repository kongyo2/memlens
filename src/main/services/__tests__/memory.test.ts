import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MEMORY_CONSTANTS } from "@shared/schema/memory.ts";

import {
  createFile,
  listFiles,
  listProjects,
  resolveProjectForPath,
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
});
