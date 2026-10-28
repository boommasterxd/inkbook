import { normalizePath, TFile, TFolder, type App, type FileManager } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { createObsidianDocumentResolver } from "../../../../src/obsidian/embeds/obsidian-document-resolver";
import { findMarkdownInkbookEmbeds } from "../../../../src/obsidian/embeds/markdown-embed";
import { ObsidianVaultFileAdapter } from "../../../../src/obsidian/vault/file-adapter";
import { ObsidianLinkAdapter } from "../../../../src/obsidian/vault/links";

const TestTFile = TFile as unknown as new (path: string) => TFile;

function createResolutionFixture(path = "drawings/My page.svg") {
  const file = new TestTFile(path);
  const getFileByPath = vi.fn((target: string) => (target === file.path ? file : null));
  const getFirstLinkpathDest = vi.fn(() => file);
  const app = {
    metadataCache: { getFirstLinkpathDest },
    vault: {
      getFileByPath,
      getResourcePath: (target: TFile) => `app://vault/${encodeURI(target.path)}`,
    },
  } as unknown as App;
  const classes = { file: TFile, folder: TFolder };
  const files = new ObsidianVaultFileAdapter(app.vault, classes, normalizePath);
  const generateMarkdownLink = vi.fn(() => "[[../drawings/My page.svg]]");
  const links = new ObsidianLinkAdapter({
    classes,
    fileManager: { generateMarkdownLink } as unknown as FileManager,
    files,
    metadataCache: app.metadataCache,
    normalizePath,
    resolution: { isResolved: () => true },
  });
  return {
    file,
    files,
    generateMarkdownLink,
    getFileByPath,
    getFirstLinkpathDest,
    links,
    resolveDocument: createObsidianDocumentResolver(app),
  };
}

describe("host-generated relative Inkbook links", () => {
  it.each([
    ["[[../drawings/My page.svg]]", "My page.svg"],
    ["[My page](../drawings/My%20page.svg)", "My page.svg"],
    ["[[../drawings/100%.svg]]", "100%.svg"],
    ["[[../drawings/My%20page.svg]]", "My%20page.svg"],
    ["[My page](../drawings/My%2520page.svg)", "My%20page.svg"],
  ])("resolves %s through both command and presentation boundaries", (markdown, filename) => {
    const h = createResolutionFixture(`drawings/${filename}`);
    h.generateMarkdownLink.mockReturnValue(markdown);
    const generated = h.links.generateEmbed(h.file.path, "notes/note.md");
    const [embed] = findMarkdownInkbookEmbeds(generated);
    expect(embed).toBeDefined();
    expect(h.links.resolveLinkTarget(embed!.linkpath, "notes/note.md")).toBe(h.file);
    expect(h.resolveDocument(embed!.linkpath, "notes/note.md")).toEqual({
      documentId: h.file.path,
      resourceUrl: `app://vault/drawings/${encodeURI(filename)}`,
    });
    expect(h.getFirstLinkpathDest).toHaveBeenCalledWith(`../drawings/${filename}`, "notes/note.md");
    expect(() => h.files.resolveFile("../drawings/My page.svg")).toThrow("invalid-path");
  });

  it.each(["https://example.com/page.svg", "/drawing.svg", "C:\\drawing.svg", "bad\0.svg"])(
    "rejects invalid or external target %s before host link resolution",
    (linkpath) => {
      const h = createResolutionFixture();
      expect(h.links.resolveLinkTarget(linkpath, "notes/note.md")).toBeNull();
      expect(h.resolveDocument(linkpath, "notes/note.md")).toBeUndefined();
      expect(h.getFirstLinkpathDest).not.toHaveBeenCalled();
    },
  );

  it.each(["https%3A%2F%2Fexample.com%2Fpage.svg", "%2Foutside.svg"])(
    "rejects a decoded external or absolute Markdown target: %s",
    (target) => {
      const h = createResolutionFixture();
      const [embed] = findMarkdownInkbookEmbeds(`!inkbook[Drawing](${target})`);
      expect(embed).toBeDefined();
      expect(h.links.resolveLinkTarget(embed!.linkpath, "notes/note.md")).toBeNull();
      expect(h.resolveDocument(embed!.linkpath, "notes/note.md")).toBeUndefined();
      expect(h.getFirstLinkpathDest).not.toHaveBeenCalled();
    },
  );

  it.each(["../outside.svg", "notes/note.md"])(
    "rejects a host result without a safe vault SVG path: %s",
    (path) => {
      const h = createResolutionFixture(path);
      expect(h.links.resolveLinkTarget("drawing.svg", "notes/note.md")).toBeNull();
      expect(h.resolveDocument("drawing.svg", "notes/note.md")).toBeUndefined();
    },
  );

  it("rejects a stale host result whose current vault identity has changed", () => {
    const h = createResolutionFixture();
    h.getFileByPath.mockReturnValue(new TestTFile(h.file.path));
    expect(h.links.resolveLinkTarget("drawing.svg", "notes/note.md")).toBeNull();
    expect(h.resolveDocument("drawing.svg", "notes/note.md")).toBeUndefined();
  });
});
