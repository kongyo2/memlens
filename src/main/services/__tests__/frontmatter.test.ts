import { describe, expect, it } from "vitest";

import {
  buildFrontmatterText,
  extractMemoryType,
  extractModifiedMs,
  extractStringField,
  parseFrontmatter,
  stampModified,
} from "../frontmatter.ts";

describe("parseFrontmatter", () => {
  it("extracts YAML frontmatter and body", () => {
    const src = `---\nname: foo\ndescription: bar\n---\nbody text\nnext line\n`;
    const { frontmatter, body, invalid } = parseFrontmatter(src);
    expect(frontmatter).toEqual({ name: "foo", description: "bar" });
    expect(body).toBe("body text\nnext line\n");
    expect(invalid).toBe(false);
  });

  it("returns null frontmatter when no fence exists", () => {
    const { frontmatter, body, invalid } = parseFrontmatter("plain body");
    expect(frontmatter).toBeNull();
    expect(body).toBe("plain body");
    expect(invalid).toBe(false);
  });

  it("recovers values containing ': ' like the official parser (quote retry)", () => {
    // Claude はこの形の description を普通に書く。 素の YAML としては invalid
    // ("Nested mappings are not allowed in compact mappings") だが、 公式
    // parseFrontmatter は quoteProblematicValues で再試行して読む。
    const src = [
      "---",
      "name: Testing policy",
      "description: Testing policy: integration tests must hit a real DB",
      "type: feedback",
      "---",
      "body",
    ].join("\n");
    const { frontmatter, invalid } = parseFrontmatter(src);
    expect(invalid).toBe(false);
    expect(extractStringField(frontmatter, "description")).toBe(
      "Testing policy: integration tests must hit a real DB",
    );
    expect(extractMemoryType(frontmatter)).toBe("feedback");
  });

  it("recovers glob-like values with braces and stars", () => {
    const src = "---\nname: rule\ndescription: applies to **/*.{ts,tsx}\n---\n";
    const { frontmatter } = parseFrontmatter(src);
    expect(extractStringField(frontmatter, "description")).toBe("applies to **/*.{ts,tsx}");
  });

  it("flags frontmatter that stays unreadable after the retry", () => {
    const src = `---\nkey: : invalid : :\n  - mixed types\n---\nbody`;
    const { frontmatter, body, invalid } = parseFrontmatter(src);
    expect(frontmatter).toBeNull();
    expect(invalid).toBe(true);
    // 公式と同じく、 読めなくてもブロックは content から外す。
    expect(body).toBe("body");
  });

  it("leaves a file intact when the closing fence is missing (even if the tail is valid YAML)", () => {
    for (const src of ["---\nname: x\ndescription: y", "---   \nname: x\ndescription: y"]) {
      const { frontmatter, body, invalid } = parseFrontmatter(src);
      expect(frontmatter).toBeNull();
      expect(body).toBe(src);
      expect(invalid).toBe(false);
    }
  });

  it("accepts a closing fence at end-of-file without a trailing newline", () => {
    const { frontmatter, body } = parseFrontmatter("---\nname: x\n---");
    expect(frontmatter).toEqual({ name: "x" });
    expect(body).toBe("");
  });

  it("treats array/scalar YAML as null frontmatter", () => {
    const src = `---\n- one\n- two\n---\nrest`;
    const { frontmatter, body, invalid } = parseFrontmatter(src);
    expect(frontmatter).toBeNull();
    expect(body).toBe("rest");
    expect(invalid).toBe(false);
  });

  it("drops an empty block from the body like the official parser", () => {
    const { frontmatter, body } = parseFrontmatter("---\n---\n# Title\n");
    expect(frontmatter).toBeNull();
    expect(body).toBe("# Title\n");
  });

  it("strips a UTF-8 BOM and handles CRLF", () => {
    const src = "﻿---\r\nname: crlf\r\ndescription: has: colon\r\n---\r\nbody\r\n";
    const { frontmatter, body } = parseFrontmatter(src);
    expect(extractStringField(frontmatter, "name")).toBe("crlf");
    expect(extractStringField(frontmatter, "description")).toBe("has: colon");
    expect(body).toBe("body\r\n");
  });

  it("keeps ISO timestamps as strings (YAML 1.2 core schema, not Date)", () => {
    const { frontmatter } = parseFrontmatter("---\nmodified: 2026-07-18T10:00:00.000Z\n---\n");
    expect(frontmatter?.["modified"]).toBe("2026-07-18T10:00:00.000Z");
  });
});

describe("extractModifiedMs", () => {
  it("parses ISO 8601 timestamps and dates", () => {
    expect(extractModifiedMs({ modified: "2026-07-18T10:00:00.000Z" })).toBe(
      Date.UTC(2026, 6, 18, 10, 0, 0),
    );
    expect(extractModifiedMs({ modified: "2026-07-18T19:00:00+09:00" })).toBe(
      Date.UTC(2026, 6, 18, 10, 0, 0),
    );
    expect(extractModifiedMs({ modified: "2026-07-18" })).toBe(Date.UTC(2026, 6, 18));
  });

  it("accepts Date values written by YAML 1.1 tools", () => {
    expect(extractModifiedMs({ modified: new Date(Date.UTC(2026, 0, 2)) })).toBe(
      Date.UTC(2026, 0, 2),
    );
  });

  it("returns null for missing or non-ISO values", () => {
    expect(extractModifiedMs(null)).toBeNull();
    expect(extractModifiedMs({})).toBeNull();
    expect(extractModifiedMs({ modified: "yesterday" })).toBeNull();
    expect(extractModifiedMs({ modified: "2026-13-45" })).toBeNull();
    expect(extractModifiedMs({ modified: 20260718 })).toBeNull();
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

  it("appends the modified timestamp when given", () => {
    const text = buildFrontmatterText({
      name: "n",
      description: "d",
      type: "project",
      modified: "2026-10-13T00:00:00.000Z",
    });
    expect(text).toContain("type: project\nmodified: 2026-10-13T00:00:00.000Z\n---\n");
    expect(extractModifiedMs(parseFrontmatter(text).frontmatter)).toBe(Date.UTC(2026, 9, 13));
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

describe("stampModified", () => {
  const ISO = "2026-10-13T04:00:00.000Z";

  it("adds modified just before the closing fence", () => {
    const src = "---\nname: x\ntype: user\n---\nbody\n";
    expect(stampModified(src, ISO)).toBe(`---\nname: x\ntype: user\nmodified: ${ISO}\n---\nbody\n`);
  });

  it("replaces an existing modified line in place (and its continuation lines)", () => {
    const src = "---\nname: x\nmodified: 2020-01-01T00:00:00Z\ntype: user\n---\nbody";
    expect(stampModified(src, ISO)).toBe(`---\nname: x\nmodified: ${ISO}\ntype: user\n---\nbody`);
    const folded = "---\nmodified: >-\n  2020-01-01\nname: x\n---\n";
    expect(stampModified(folded, ISO)).toBe(`---\nmodified: ${ISO}\nname: x\n---\n`);
  });

  it("never adds frontmatter to a file without one (official rule)", () => {
    for (const src of ["plain body\n", "", "- index entry\n---\nnot frontmatter\n"]) {
      expect(stampModified(src, ISO)).toBe(src);
    }
  });

  it("leaves unreadable frontmatter untouched", () => {
    const src = "---\nkey: : invalid : :\n  - mixed\n---\nbody";
    expect(stampModified(src, ISO)).toBe(src);
  });

  it("preserves comments, quoting, key order, CRLF and BOM", () => {
    const src =
      "﻿---\r\nname: 'quoted # not a comment'\r\n# a comment\r\ntype: user\r\n---\r\nbody\r\n";
    const out = stampModified(src, ISO);
    expect(out).toBe(
      `﻿---\r\nname: 'quoted # not a comment'\r\n# a comment\r\ntype: user\r\nmodified: ${ISO}\r\n---\r\nbody\r\n`,
    );
    expect(extractStringField(parseFrontmatter(out).frontmatter, "name")).toBe(
      "quoted # not a comment",
    );
  });

  it("does not mistake other keys that start with 'modified'", () => {
    const src = "---\nmodifiedBy: alice\n---\n";
    expect(stampModified(src, ISO)).toBe(`---\nmodifiedBy: alice\nmodified: ${ISO}\n---\n`);
  });
});
