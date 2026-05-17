import { describe, expect, it } from "vitest";

import { guessProjectPath, sanitizePath } from "../sanitize.ts";

describe("sanitizePath", () => {
  it("replaces non-alphanumeric chars with hyphen", () => {
    expect(sanitizePath("C:\\Users\\alice\\projects\\app")).toBe(
      "C--Users-alice-projects-app",
    );
    expect(sanitizePath("/home/alice/my-project")).toBe(
      "-home-alice-my-project",
    );
    expect(sanitizePath("plugin:name:server")).toBe("plugin-name-server");
  });

  it("preserves short names verbatim (under 200 chars)", () => {
    const short = "a".repeat(199);
    expect(sanitizePath(short)).toBe(short);
    const exact = "b".repeat(200);
    expect(sanitizePath(exact)).toBe(exact);
  });

  it("appends djb2 hash when exceeding 200 chars", () => {
    const long = "a".repeat(250);
    const result = sanitizePath(long);
    expect(result.startsWith("a".repeat(200))).toBe(true);
    expect(result).toMatch(/^a{200}-[0-9a-z]+$/);
  });

  it("produces stable hash across calls", () => {
    const long = "b".repeat(300);
    expect(sanitizePath(long)).toBe(sanitizePath(long));
  });

  it("differentiates two different long inputs by hash suffix", () => {
    const a = "a".repeat(220);
    const b = "a".repeat(219) + "b";
    expect(sanitizePath(a)).not.toBe(sanitizePath(b));
  });
});

describe("guessProjectPath", () => {
  it("decodes Windows drive style", () => {
    expect(guessProjectPath("C--Users-alice-projects-app")).toBe(
      "C:\\Users\\alice\\projects\\app",
    );
  });

  it("decodes POSIX root style (best-effort, every `-` becomes `/`)", () => {
    // sanitize は破壊的なので元 path 内の `-` も `/` に化ける。 復元は最善推定のみ。
    expect(guessProjectPath("-home-alice-my-project")).toBe(
      "/home/alice/my/project",
    );
  });

  it("returns null when no leading sentinel", () => {
    expect(guessProjectPath("plugin-name-server")).toBeNull();
  });
});
