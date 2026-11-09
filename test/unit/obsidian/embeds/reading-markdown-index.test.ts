import { afterEach, describe, expect, it, vi } from "vitest";

import * as markdown from "../../../../src/obsidian/embeds/markdown-embed";
import {
  ReadingMarkdownIndex,
  READING_MARKDOWN_INDEX_LIMITS,
} from "../../../../src/obsidian/embeds/reading-markdown-index";

afterEach(() => vi.restoreAllMocks());

describe("Reading Markdown source index", () => {
  it("maps inclusive CRLF sections after BOM frontmatter without requiring a final newline", () => {
    const text =
      "\uFEFF---\r\ncover: hidden\r\n---\r\n\r\n  ![[drawing.svg|400]]\r\n\r\n![Last](last.svg)";
    const index = new ReadingMarkdownIndex();
    const first = index.standaloneEmbed("note.md", { text, lineStart: 3, lineEnd: 5 });
    expect(first).toEqual({
      from: text.indexOf("![["),
      to: text.indexOf("]]") + 2,
      markdown: "![[drawing.svg|400]]",
      linkpath: "drawing.svg",
      width: 400,
    });
    expect(index.standaloneEmbed("note.md", { text, lineStart: 6, lineEnd: 6 })).toMatchObject({
      markdown: "![Last](last.svg)",
      to: text.length,
    });
  });

  it.each([
    { text: "", lineStart: 0, lineEnd: 0 },
    { text: "![[one.svg]]\n", lineStart: 1, lineEnd: 1 },
    { text: "![[one.svg]]", lineStart: -1, lineEnd: 0 },
    { text: "![[one.svg]]", lineStart: 0, lineEnd: 1 },
    { text: "![[one.svg]]", lineStart: 0.5, lineEnd: 1 },
    { text: "![[one.svg]]", lineStart: 0, lineEnd: Infinity },
    { text: "![[one.svg]]\n![[two.svg]]", lineStart: 0, lineEnd: 1 },
    { text: "Before\n![[one.svg]]", lineStart: 0, lineEnd: 1 },
    { text: "---\n![[one.svg]]\n---", lineStart: 1, lineEnd: 1 },
    { text: "<!--\n![[one.svg]]\n-->", lineStart: 1, lineEnd: 1 },
    { text: "```\n![[one.svg]]\n```", lineStart: 1, lineEnd: 1 },
  ])("fails closed for invalid or non-standalone current sections: $text", (section) => {
    expect(new ReadingMarkdownIndex().standaloneEmbed("note.md", section)).toBeUndefined();
  });

  it("reuses exact positive and negative sources and replaces them immediately after edits", () => {
    const parse = vi.spyOn(markdown, "findMarkdownInkbookEmbeds");
    const index = new ReadingMarkdownIndex();
    const section = { text: "![[one.svg]]", lineStart: 0, lineEnd: 0 };
    expect(index.standaloneEmbed("note.md", section)?.linkpath).toBe("one.svg");
    expect(index.standaloneEmbed("note.md", { ...section })?.linkpath).toBe("one.svg");
    expect(parse).toHaveBeenCalledOnce();
    expect(index.standaloneEmbed("note.md", { ...section, text: "No image" })).toBeUndefined();
    expect(index.standaloneEmbed("note.md", { ...section, text: "No image" })).toBeUndefined();
    expect(parse).toHaveBeenCalledTimes(2);
    expect(index.standaloneEmbed("note.md", section)?.linkpath).toBe("one.svg");
    expect(parse).toHaveBeenCalledTimes(3);
  });

  it("evicts the least recently queried path and keeps independent processor ownership", () => {
    const parse = vi.spyOn(markdown, "findMarkdownInkbookEmbeds");
    const index = new ReadingMarkdownIndex();
    const section = { text: "![[one.svg]]", lineStart: 0, lineEnd: 0 };
    for (let path = 0; path < READING_MARKDOWN_INDEX_LIMITS.entries; path += 1)
      index.standaloneEmbed(`${String(path)}.md`, section);
    index.standaloneEmbed("0.md", section);
    index.standaloneEmbed("new.md", section);
    index.standaloneEmbed("0.md", section);
    expect(parse).toHaveBeenCalledTimes(READING_MARKDOWN_INDEX_LIMITS.entries + 1);
    index.standaloneEmbed("1.md", section);
    new ReadingMarkdownIndex().standaloneEmbed("0.md", section);
    expect(parse).toHaveBeenCalledTimes(READING_MARKDOWN_INDEX_LIMITS.entries + 3);
  });

  it("releases all retained sources when its plugin owner clears the index", () => {
    const parse = vi.spyOn(markdown, "findMarkdownInkbookEmbeds");
    const index = new ReadingMarkdownIndex();
    const section = { text: "![[one.svg]]", lineStart: 0, lineEnd: 0 };
    index.standaloneEmbed("first.md", section);
    index.standaloneEmbed("second.md", section);
    index.clear();
    index.clear();
    expect(index.standaloneEmbed("first.md", section)?.linkpath).toBe("one.svg");
    expect(index.standaloneEmbed("second.md", section)?.linkpath).toBe("one.svg");
    expect(parse).toHaveBeenCalledTimes(4);
  });
});
