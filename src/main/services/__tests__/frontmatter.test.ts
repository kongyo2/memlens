import { describe, expect, it } from "vitest";

import {
  buildFrontmatterText,
  extractMemoryType,
  extractStringField,
  parseFrontmatter,
} from "../frontmatter.ts";

describe("parseFrontmatter", () => {
  it("extracts YAML frontmatter and body", () => {
    const src = `---\nname: foo\ndescription: bar\n---\nbody text\nnext line\n`;
    const { frontmatter, body } = parseFrontmatter(src);
    expect(frontmatter).toEqual({ name: "foo", description: "bar" });
    expect(body).toBe("body text\nnext line\n");
  });

  it("returns null frontmatter when no fence exists", () => {
    const { frontmatter, body } = parseFrontmatter("plain body");
    expect(frontmatter).toBeNull();
    expect(body).toBe("plain body");
  });

  it("returns null frontmatter on YAML parse error", () => {
    const src = `---\nkey: : invalid : :\n  - mixed types\n---\nbody`;
    const { frontmatter, body } = parseFrontmatter(src);
    expect(frontmatter).toBeNull();
    expect(body).toBe(src);
  });

  it("leaves a file intact when the closing fence is missing (even if the tail is valid YAML)", () => {
    // 閉じフェンス無しで gray-matter に渡すと、 残り全体が YAML として valid な
    // ときに本文が空 + でっち上げ frontmatter になってしまう。 完全なブロックが
    // 無い限り frontmatter なし扱いにする (公式 regex も閉じ区切りを要求する)。
    for (const src of ["---\nname: x\ndescription: y", "---   \nname: x\ndescription: y"]) {
      const { frontmatter, body } = parseFrontmatter(src);
      expect(frontmatter).toBeNull();
      expect(body).toBe(src);
    }
  });

  it("accepts a closing fence at end-of-file without a trailing newline", () => {
    const { frontmatter, body } = parseFrontmatter("---\nname: x\n---");
    expect(frontmatter).toEqual({ name: "x" });
    expect(body).toBe("");
  });

  it("treats array/scalar YAML as null frontmatter", () => {
    const src = `---\n- one\n- two\n---\nrest`;
    const { frontmatter } = parseFrontmatter(src);
    expect(frontmatter).toBeNull();
  });
});

describe("extractMemoryType", () => {
  it("reads root-level type (official shape)", () => {
    expect(extractMemoryType({ type: "feedback" })).toBe("feedback");
  });

  it("falls back to metadata.type (auto-memory prompt shape)", () => {
    expect(extractMemoryType({ metadata: { type: "project" } })).toBe("project");
  });

  it("prefers root over metadata when both present", () => {
    expect(
      extractMemoryType({
        type: "user",
        metadata: { type: "feedback" },
      }),
    ).toBe("user");
  });

  it("rejects unknown values", () => {
    expect(extractMemoryType({ type: "weird" })).toBeNull();
    expect(extractMemoryType({ metadata: { type: 42 } })).toBeNull();
  });

  it("returns null for empty / non-object", () => {
    expect(extractMemoryType(null)).toBeNull();
    expect(extractMemoryType({})).toBeNull();
    expect(extractMemoryType({ metadata: null })).toBeNull();
    expect(extractMemoryType({ metadata: ["x"] })).toBeNull();
  });
});

describe("extractStringField", () => {
  it("returns trimmed string when present", () => {
    expect(extractStringField({ name: "  foo  " }, "name")).toBe("foo");
  });
  it("returns null for non-string or empty", () => {
    expect(extractStringField({ name: 42 }, "name")).toBeNull();
    expect(extractStringField({ name: "   " }, "name")).toBeNull();
    expect(extractStringField(null, "name")).toBeNull();
  });
});

describe("buildFrontmatterText", () => {
  it("emits canonical 3-key frontmatter (delegated to yaml.stringify)", () => {
    const text = buildFrontmatterText({
      name: "my-user-mem",
      description: "what the user prefers",
      type: "user",
    });
    expect(text).toBe(
      [
        "---",
        "name: my-user-mem",
        "description: what the user prefers",
        "type: user",
        "---",
        "",
      ].join("\n"),
    );
  });

  it("delegates value quoting to yaml.stringify (only quotes when needed)", () => {
    const text = buildFrontmatterText({
      name: "a:b",
      description: "has # hash",
      type: "feedback",
    });
    // `a:b` は colon+non-whitespace なので YAML scalar として安全 → quote 不要。
    // `has # hash` は前後 whitespace ありの `#` を含むのでコメント解釈を避けるため quote される。
    expect(text).toContain("name: a:b");
    expect(text).toContain('description: "has # hash"');
    expect(text).toContain("type: feedback");
  });
});
