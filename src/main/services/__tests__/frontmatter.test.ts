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
    expect(extractMemoryType({ metadata: { type: "project" } })).toBe(
      "project",
    );
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
  it("emits canonical 4-key frontmatter", () => {
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

  it("quotes values that contain YAML-special characters", () => {
    const text = buildFrontmatterText({
      name: "a:b",
      description: "has # hash",
      type: "feedback",
    });
    expect(text).toContain('name: "a:b"');
    expect(text).toContain('description: "has # hash"');
  });
});
