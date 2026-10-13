import { describe, expect, it } from "vitest";

import { splitFrontmatter } from "../frontmatterBlock.ts";

describe("splitFrontmatter", () => {
  it("returns the whole input as body when there is no fence", () => {
    expect(splitFrontmatter("# Title\n")).toEqual({ yaml: null, body: "# Title\n" });
  });

  it("splits the YAML text from the body", () => {
    // 公式 regex は閉じフェンス後の空白 (空行を含む) もまとめて外す。
    expect(splitFrontmatter("---\nname: x\n---\n\nbody\n")).toEqual({
      yaml: "name: x\n",
      body: "body\n",
    });
  });

  it("splits even when the YAML itself is broken (the official content drops the block)", () => {
    expect(splitFrontmatter('---\ndescription: "open\n---\nbody')).toEqual({
      yaml: 'description: "open\n',
      body: "body",
    });
  });

  it("ignores a leading BOM and keeps CRLF inside the block", () => {
    expect(splitFrontmatter("﻿---\r\nname: x\r\n---\r\nbody\r\n")).toEqual({
      yaml: "name: x\r\n",
      body: "body\r\n",
    });
  });

  it("needs a closing fence", () => {
    expect(splitFrontmatter("---\nname: x\n")).toEqual({ yaml: null, body: "---\nname: x\n" });
  });
});
