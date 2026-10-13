import { MEMORY_CONSTANTS } from "@shared/schema/memory.ts";
import { describe, expect, it } from "vitest";

import { computeLoadedIndex, stripBlockHtmlComments, stripFrontmatterBlock } from "../indexLoad.ts";

const { MAX_ENTRYPOINT_LINES } = MEMORY_CONSTANTS;

/**
 * 公式ロード経路 (src/utils/claudemd.ts parseMemoryFileContent) の再現を検証。
 * docs/memory.md (min-version 2.1.211): "YAML frontmatter and block-level HTML
 * comments are stripped before the index is loaded, so they don't count toward
 * the limits."
 */
describe("stripFrontmatterBlock", () => {
  it("removes a well-formed frontmatter block", () => {
    const src = "---\nname: x\ntype: user\n---\nbody line\n";
    expect(stripFrontmatterBlock(src)).toBe("body line\n");
  });

  it("removes the block even when the YAML inside is invalid (official slices regardless)", () => {
    const src = "---\n:{ not yaml ::\n---\nbody\n";
    expect(stripFrontmatterBlock(src)).toBe("body\n");
  });

  it("keeps content when there is no closing fence", () => {
    const src = "---\nname: x\nno closing fence\n";
    expect(stripFrontmatterBlock(src)).toBe(src);
  });

  it("keeps content that merely starts with a horizontal rule context", () => {
    const src = "body first\n---\nsection\n---\n";
    expect(stripFrontmatterBlock(src)).toBe(src);
  });

  it("handles CRLF fences (official \\s* consumes the \\r)", () => {
    const src = "---\r\nname: x\r\n---\r\nbody\r\n";
    expect(stripFrontmatterBlock(src)).toBe("body\r\n");
  });
});

describe("stripBlockHtmlComments", () => {
  it("returns input unchanged when there is no comment", () => {
    const src = "line a\nline b";
    expect(stripBlockHtmlComments(src)).toBe(src);
  });

  it("strips a standalone block comment while keeping surrounding blank lines (marked token boundaries)", () => {
    // marked は空行を独立した space token にするので、 コメント token だけが
    // 落ちて前後の空行はそのまま残る (公式も同じ結果になる)。
    const src = "para one\n\n<!-- authorial note -->\n\npara two";
    expect(stripBlockHtmlComments(src)).toBe("para one\n\n\n\npara two");
  });

  it("strips a multi-line block comment", () => {
    const src = "a\n<!-- one\ntwo\nthree -->\nb";
    expect(stripBlockHtmlComments(src)).toBe("a\nb");
  });

  it("keeps residue after --> on the closing line", () => {
    const src = "<!-- note --> Use bun\nnext";
    expect(stripBlockHtmlComments(src)).toBe(" Use bun\nnext");
  });

  it("keeps inline comments inside a paragraph line", () => {
    const src = "Use bun <!-- not a block --> always\n";
    expect(stripBlockHtmlComments(src)).toBe("Use bun <!-- not a block --> always\n");
  });

  it("keeps comments inside fenced code blocks", () => {
    const src = "```html\n<!-- kept -->\n```\nafter";
    expect(stripBlockHtmlComments(src)).toBe(src);
  });

  it("keeps comments inside tilde fences with info strings", () => {
    const src = "~~~ markdown\n<!-- kept -->\n~~~\n";
    expect(stripBlockHtmlComments(src)).toBe(src);
  });

  it("leaves unclosed comments in place so a typo doesn't swallow the file", () => {
    const src = "a\n<!-- oops no close\nb\n";
    expect(stripBlockHtmlComments(src)).toBe(src);
  });

  it("strips comments indented up to three spaces after a blank line", () => {
    const src = "a\n\n   <!-- c -->\nb";
    expect(stripBlockHtmlComments(src)).toBe("a\n\nb");
  });

  it("keeps an indented comment that continues a paragraph (marked keeps it in the paragraph token)", () => {
    const src = "a\n   <!-- c -->\nb";
    expect(stripBlockHtmlComments(src)).toBe(src);
  });

  it("keeps comments nested inside list items (official walks only top-level tokens)", () => {
    const src = "- entry\n  <!-- metadata -->\n";
    expect(stripBlockHtmlComments(src)).toBe(src);
  });

  it("keeps 4-space-indented comment lines (indented code / continuation)", () => {
    const src = "a\n\n    <!-- code block -->\n";
    expect(stripBlockHtmlComments(src)).toBe(src);
  });

  it("handles multiple comments on one line independently", () => {
    const src = "<!-- a --> mid <!-- b -->\n";
    expect(stripBlockHtmlComments(src)).toBe(" mid \n");
  });
});

describe("computeLoadedIndex", () => {
  it("does not count frontmatter lines toward the 200-line limit", () => {
    const frontmatter = "---\nname: index\ndescription: d\ntype: project\n---\n";
    const body = Array.from(
      { length: MAX_ENTRYPOINT_LINES },
      (_, i) => `- entry ${String(i)}`,
    ).join("\n");
    const r = computeLoadedIndex(frontmatter + body);
    expect(r.lineCount).toBe(MAX_ENTRYPOINT_LINES);
    expect(r.wasLineTruncated).toBe(false);
    expect(r.content).not.toContain("name: index");
  });

  it("does not count block comments toward the limits", () => {
    const comment = "<!-- machine generated, do not edit -->\n\n";
    const body = Array.from(
      { length: MAX_ENTRYPOINT_LINES },
      (_, i) => `- entry ${String(i)}`,
    ).join("\n");
    const r = computeLoadedIndex(comment + body);
    expect(r.lineCount).toBe(MAX_ENTRYPOINT_LINES);
    expect(r.wasLineTruncated).toBe(false);
  });

  it("still truncates when the stripped body exceeds the line limit", () => {
    const body = Array.from(
      { length: MAX_ENTRYPOINT_LINES + 5 },
      (_, i) => `- entry ${String(i)}`,
    ).join("\n");
    const r = computeLoadedIndex(`---\ntype: project\n---\n${body}`);
    expect(r.wasLineTruncated).toBe(true);
    expect(r.lineCount).toBe(MAX_ENTRYPOINT_LINES + 5);
    expect(r.loadedLineCount).toBe(MAX_ENTRYPOINT_LINES);
    expect(r.content.split("\n").at(-1)).toBe(`- entry ${String(MAX_ENTRYPOINT_LINES - 1)}`);
    expect(r.dropped.split("\n")).toHaveLength(5);
    expect(r.dropped.startsWith(`- entry ${String(MAX_ENTRYPOINT_LINES)}`)).toBe(true);
  });

  it("strips a leading UTF-8 BOM before measuring", () => {
    const r = computeLoadedIndex("\uFEFF---\ntype: user\n---\n- entry\n");
    expect(r.content).toBe("- entry");
    expect(r.lineCount).toBe(1);
  });

  it("byteCount reflects the loaded (stripped + trimmed) content only", () => {
    const r = computeLoadedIndex("---\nname: x\n---\n- entry\n");
    expect(r.byteCount).toBe("- entry".length);
  });
});
