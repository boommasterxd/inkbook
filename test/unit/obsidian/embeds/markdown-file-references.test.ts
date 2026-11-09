import { describe, expect, it } from "vitest";

import { countMarkdownFileReferences } from "../../../../src/obsidian/embeds/markdown-file-references";

const resolution = {
  sourcePath: "note.md",
  targetPath: "drawings/my page.svg",
  resolveLinkTarget: (linkpath: string) =>
    ["drawings/my page.svg", "my page"].includes(linkpath)
      ? { path: "drawings/my page.svg" }
      : null,
};

describe("Markdown file references", () => {
  it("counts ordinary, sized, inline and extensionless links independently of presentations", () => {
    const text = [
      "![[drawings/my page.svg]]",
      "Inline ![[drawings/my page.svg|100x200]] and [[my page#heading]]",
      '[Normal link](<drawings/my%20page.svg> "title")',
      "![Drawing](drawings/my%20page.svg#fragment)",
      "[Other](other.svg)",
    ].join("\n");
    expect(countMarkdownFileReferences(text, resolution)).toEqual({
      complete: true,
      references: 5,
    });
  });

  it.each([
    "[drawing]: drawings/my%20page.svg\n![drawing]",
    "[Drawing](drawings/my\\ page.svg)",
    "[Drawing](drawings/my&#32;page.svg)",
    '<img src="drawings/my page.svg">',
    "[Drawing](unclosed.svg",
  ])("does not authorize file deletion when a reference cannot be fully counted", (text) => {
    expect(countMarkdownFileReferences(text, resolution).complete).toBe(false);
  });
});
