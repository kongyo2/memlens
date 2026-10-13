import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearProjectPathCache,
  cwdMatchesProjectName,
  extractJsonStringField,
  projectPathFromTranscripts,
} from "../projectPath.ts";
import { sanitizePath } from "../sanitize.ts";

describe("extractJsonStringField (official sessionStoragePortable port)", () => {
  it("reads the first value without a full JSON parse", () => {
    const text = '{"type":"user","cwd":"/a/b","x":1}\n{"cwd":"/c"}';
    expect(extractJsonStringField(text, "cwd")).toBe("/a/b");
  });

  it("unescapes JSON escapes and tolerates `: ` spacing", () => {
    expect(extractJsonStringField('{"cwd": "C:\\\\Users\\\\me \\"x\\""}', "cwd")).toBe(
      'C:\\Users\\me "x"',
    );
  });

  it("returns undefined for a missing or unterminated value", () => {
    expect(extractJsonStringField('{"other":"x"}', "cwd")).toBeUndefined();
    expect(extractJsonStringField('{"cwd":"/never/closed', "cwd")).toBeUndefined();
  });
});

describe("cwdMatchesProjectName", () => {
  it("matches only when the cwd sanitizes to the folder name", () => {
    const cwd = resolve("/Users/me/my-app");
    expect(cwdMatchesProjectName(cwd, sanitizePath(cwd))).toBe(true);
    expect(cwdMatchesProjectName(resolve("/Users/me/other"), sanitizePath(cwd))).toBe(false);
  });

  it("tolerates a different hash suffix for long paths", () => {
    const cwd = resolve(`/${"a".repeat(260)}`);
    const name = `${sanitizePath(cwd).slice(0, 200)}-bunhash`;
    expect(cwdMatchesProjectName(cwd, name)).toBe(true);
  });
});

describe("projectPathFromTranscripts", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "memlens-transcripts-"));
    clearProjectPathCache();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns the cwd recorded in a transcript of that project folder", async () => {
    const cwd = resolve("/srv/repo.with.dots");
    const name = sanitizePath(cwd);
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "s1.jsonl"), `${JSON.stringify({ cwd })}\n`, "utf8");
    expect(await projectPathFromTranscripts(dir, name)).toBe(cwd);
  });

  it("ignores transcripts whose cwd belongs to a different folder name", async () => {
    const name = sanitizePath(resolve("/srv/repo"));
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "s1.jsonl"), `${JSON.stringify({ cwd: "/elsewhere" })}\n`, "utf8");
    expect(await projectPathFromTranscripts(dir, name)).toBeNull();
  });

  it("returns null when the folder has no transcripts", async () => {
    const dir = join(root, "-x");
    await mkdir(dir, { recursive: true });
    expect(await projectPathFromTranscripts(dir, "-x")).toBeNull();
  });
});
