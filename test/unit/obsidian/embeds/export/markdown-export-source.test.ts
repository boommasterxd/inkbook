import { TFile, type App } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { readMarkdownExportSource } from "../../../../../src/obsidian/embeds/export/markdown-export-source";

function sourceHarness(options: {
  readonly activePath?: string;
  readonly mode?: "preview" | "source";
  readonly missing?: boolean;
}) {
  const File = TFile as unknown as new (path: string) => TFile;
  const file = new File("note.md");
  const getValue = vi.fn(() => "unsaved editor content");
  const cachedRead = vi.fn(async () => "current vault content");
  const getAbstractFileByPath = vi.fn(() => (options.missing ? null : file));
  const app = {
    workspace: {
      getActiveViewOfType: () =>
        options.activePath === undefined
          ? null
          : {
              file: { path: options.activePath },
              getMode: () => options.mode ?? "source",
              editor: { getValue },
            },
    },
    vault: { cachedRead, getAbstractFileByPath },
  } as unknown as Pick<App, "workspace" | "vault">;
  return { app, cachedRead, file, getAbstractFileByPath, getValue };
}

describe("Markdown export source selection", () => {
  it("uses unsaved content from the matching active source or Live Preview editor", async () => {
    const { app, cachedRead, getAbstractFileByPath, getValue } = sourceHarness({
      activePath: "note.md",
      mode: "source",
    });

    expect(await readMarkdownExportSource(app, "note.md")).toBe("unsaved editor content");
    expect(getValue).toHaveBeenCalledOnce();
    expect(cachedRead).not.toHaveBeenCalled();
    expect(getAbstractFileByPath).not.toHaveBeenCalled();
  });

  it.each([
    { activePath: "note.md", mode: "preview" as const },
    { activePath: "other.md", mode: "source" as const },
    {},
  ])("uses current vault content for $activePath in $mode", async (options) => {
    const { app, cachedRead, file, getAbstractFileByPath, getValue } = sourceHarness(options);

    expect(await readMarkdownExportSource(app, "note.md")).toBe("current vault content");
    expect(getAbstractFileByPath).toHaveBeenCalledExactlyOnceWith("note.md");
    expect(cachedRead).toHaveBeenCalledExactlyOnceWith(file);
    expect(getValue).not.toHaveBeenCalled();
  });

  it("returns no source when the requested vault file is missing", async () => {
    const { app, cachedRead } = sourceHarness({ missing: true });

    expect(await readMarkdownExportSource(app, "missing.md")).toBeUndefined();
    expect(cachedRead).not.toHaveBeenCalled();
  });
});
