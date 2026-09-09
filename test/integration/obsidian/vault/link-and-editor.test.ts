import type { Editor, FileManager, MetadataCache, Vault } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { ObsidianEditorMutationAdapter } from "../../../../src/obsidian/vault/editor-mutations";
import { ObsidianVaultFileAdapter } from "../../../../src/obsidian/vault/file-adapter";
import { ObsidianLinkAdapter } from "../../../../src/obsidian/vault/links";
import { fakeObsidianFileClasses, FakeObsidianFile } from "../../../fixtures/obsidian/vault-files";

function createLinkAdapter(options: {
  readonly generatedLink?: string;
  readonly resolved: boolean;
  readonly resolvedLinks: Record<string, Record<string, number>>;
}) {
  const target = new FakeObsidianFile("drawings/page.svg");
  const vault = {
    getFileByPath: (path: string) => (path === target.path ? target : null),
  } as unknown as Vault;
  const files = new ObsidianVaultFileAdapter(vault, fakeObsidianFileClasses, (path) => path);
  const generateMarkdownLink = vi.fn(() => options.generatedLink ?? "[[../drawings/page.svg]]");
  const getFirstLinkpathDest = vi.fn((linkpath: string) =>
    linkpath === "page.svg" ? target : null,
  );
  const adapter = new ObsidianLinkAdapter({
    classes: fakeObsidianFileClasses,
    fileManager: { generateMarkdownLink } as unknown as FileManager,
    files,
    metadataCache: {
      getFirstLinkpathDest,
      resolvedLinks: options.resolvedLinks,
    } as unknown as MetadataCache,
    normalizePath: (path) => path,
    resolution: { isResolved: () => options.resolved },
  });
  return { adapter, generateMarkdownLink, getFirstLinkpathDest, target };
}

describe("Obsidian link boundary", () => {
  it("generates embed Markdown through FileManager", () => {
    const { adapter, generateMarkdownLink, target } = createLinkAdapter({
      resolved: true,
      resolvedLinks: {},
    });

    expect(adapter.generateEmbed(target.path, "notes/note.md")).toBe(
      "!inkbook[[../drawings/page.svg]]",
    );
    expect(generateMarkdownLink).toHaveBeenCalledWith(target, "notes/note.md");
  });

  it("rejects an incomplete host-generated link before it reaches the editor", () => {
    const { adapter, target } = createLinkAdapter({
      generatedLink: "[[../drawings/page.svg",
      resolved: true,
      resolvedLinks: {},
    });

    expect(() => adapter.generateEmbed(target.path, "notes/note.md")).toThrow(
      "Obsidian generated an incomplete Markdown link.",
    );
  });

  it("resolves linkpaths only to concrete files", () => {
    const { adapter, getFirstLinkpathDest, target } = createLinkAdapter({
      resolved: true,
      resolvedLinks: {},
    });

    expect(adapter.resolveLinkTarget("page.svg", "notes/note.md")).toBe(target);
    expect(adapter.resolveLinkTarget("missing.svg", "notes/note.md")).toBeNull();
    expect(adapter.resolveLinkTarget("../page.svg", "notes/note.md")).toBeNull();
    expect(getFirstLinkpathDest).toHaveBeenCalledWith("page.svg", "notes/note.md");
  });

  it("denies deletion knowledge until metadata is resolved", () => {
    const { adapter } = createLinkAdapter({
      resolved: false,
      resolvedLinks: { "notes/a.md": { "drawings/page.svg": 1 } },
    });

    expect(adapter.referenceKnowledge("drawings/page.svg")).toEqual({ state: "unresolved" });
  });

  it("counts resolved references without scanning Markdown files", () => {
    const { adapter } = createLinkAdapter({
      resolved: true,
      resolvedLinks: {
        "notes/a.md": { "drawings/page.svg": 1 },
        "notes/b.md": { "drawings/page.svg": 2 },
      },
    });

    expect(adapter.referenceKnowledge("drawings/page.svg")).toEqual({
      state: "resolved",
      references: 3,
    });
  });

  it("uses the current editor count instead of stale metadata for its source note", () => {
    const { adapter } = createLinkAdapter({
      resolved: true,
      resolvedLinks: {
        "notes/a.md": { "drawings/page.svg": 12 },
        "notes/b.md": { "drawings/page.svg": 2 },
      },
    });

    expect(
      adapter.referenceKnowledge("drawings/page.svg", {
        references: 1,
        sourcePath: "notes/a.md",
      }),
    ).toEqual({ state: "resolved", references: 3 });
  });

  it("treats malformed cache counts as unresolved", () => {
    const { adapter } = createLinkAdapter({
      resolved: true,
      resolvedLinks: { "notes/a.md": { "drawings/page.svg": Number.NaN } },
    });

    expect(adapter.referenceKnowledge("drawings/page.svg")).toEqual({ state: "unresolved" });
  });
});

describe("Obsidian editor mutation boundary", () => {
  it("uses replaceRange only after an exact current-text check", () => {
    const replaceRange = vi.fn();
    const editor = {
      getRange: vi.fn(() => "!inkbook[[old.svg]]"),
      replaceRange,
    } as unknown as Editor;
    const mutations = new ObsidianEditorMutationAdapter(editor);

    expect(
      mutations.replaceIfUnchanged({
        expected: "!inkbook[[old.svg]]",
        range: { from: { ch: 0, line: 3 }, to: { ch: 12, line: 3 } },
        replacement: "!inkbook[[new.svg]]",
      }),
    ).toBe(true);
    expect(replaceRange).toHaveBeenCalledWith(
      "!inkbook[[new.svg]]",
      { ch: 0, line: 3 },
      { ch: 12, line: 3 },
    );
  });

  it("preserves the editor when the expected range is stale", () => {
    const replaceRange = vi.fn();
    const mutations = new ObsidianEditorMutationAdapter({
      getRange: () => "changed",
      replaceRange,
    } as unknown as Editor);

    expect(
      mutations.replaceIfUnchanged({
        expected: "original",
        range: { from: { ch: 0, line: 0 }, to: { ch: 8, line: 0 } },
        replacement: "replacement",
      }),
    ).toBe(false);
    expect(replaceRange).not.toHaveBeenCalled();
  });

  it("inserts through Editor.replaceRange", () => {
    const replaceRange = vi.fn();
    const mutations = new ObsidianEditorMutationAdapter({ replaceRange } as unknown as Editor);

    mutations.insert("!inkbook[[new.svg]]\n", { ch: 0, line: 4 });

    expect(replaceRange).toHaveBeenCalledWith("!inkbook[[new.svg]]\n", { ch: 0, line: 4 });
  });

  it("inserts an embed only on a still-empty Markdown line", () => {
    const replaceRange = vi.fn();
    const getLine = vi.fn((line: number) => (line === 2 ? "" : "occupied"));
    const mutations = new ObsidianEditorMutationAdapter({
      getLine,
      lineCount: () => 4,
      replaceRange,
    } as unknown as Editor);

    expect(mutations.insertEmbedOnEmptyLine("!inkbook[[new.svg]]", 2)?.line).toBe(4);
    expect(mutations.insertEmbedOnEmptyLine("!inkbook[[new.svg]]", 3)).toBeUndefined();
    expect(replaceRange).toHaveBeenCalledTimes(1);
    expect(replaceRange).toHaveBeenCalledWith(
      "\n\n!inkbook[[new.svg]]\n",
      { ch: 0, line: 2 },
      { ch: 0, line: 2 },
    );
  });
});
