import { describe, expect, it } from "vitest";

import {
  type CopyEmbedOutcome,
  type DeleteEmbedOutcome,
} from "../../../../src/obsidian/commands/embed-actions";
import type {
  LivePreviewEmbedReference,
  ReadingViewEmbedReference,
} from "../../../../src/obsidian/embeds/presentation/presentation-port";
import { createHarness } from "./embed-actions-fixture";

function expectRemovedWithoutTrash(
  harness: ReturnType<typeof createHarness>,
  result: DeleteEmbedOutcome,
): void {
  expect(result).toEqual({ fileDeleted: false, kind: "deleted" } satisfies DeleteEmbedOutcome);
  expect(harness.editor.value()).toBe("");
  expect(harness.trashFile).not.toHaveBeenCalled();
}

function livePreviewReference(
  overrides: Partial<LivePreviewEmbedReference> = {},
): LivePreviewEmbedReference {
  return {
    documentId: "drawings/page.svg",
    from: 0,
    kind: "live-preview",
    sourcePath: "notes/note.md",
    to: 21,
    ...overrides,
  };
}

function readingViewReference(markdown: string): ReadingViewEmbedReference {
  return {
    documentId: "drawings/page.svg",
    kind: "reading-view",
    markdown,
    section: { lineEnd: 0, lineStart: 0, text: markdown },
    sectionFrom: 0,
    sectionTo: markdown.length,
    sourcePath: "notes/note.md",
  };
}

describe("Obsidian embed actions", () => {
  it("copies complete embed Markdown through the owner window clipboard", async () => {
    const harness = createHarness();

    const result = await harness.actions.copyEmbed("drawings/page.svg");

    expect(result).toEqual({
      kind: "copied",
      markdown: "!inkbook[[drawings/page.svg]]",
    } satisfies CopyEmbedOutcome);
    expect(harness.generateMarkdownLink).not.toHaveBeenCalled();
    expect(harness.writeText).toHaveBeenCalledWith("!inkbook[[drawings/page.svg]]");
  });

  it("rejects an ambiguous active reference without mutating the editor", async () => {
    const harness = createHarness({
      documentText: "!inkbook[[drawings/page.svg]]\n!inkbook[[drawings/page.svg]]",
      references: 2,
    });

    const result = await harness.actions.deleteEmbed("drawings/page.svg");

    expect(result).toEqual({
      kind: "unavailable",
      reason: "ambiguous-embed",
    } satisfies DeleteEmbedOutcome);
    expect(harness.confirm).not.toHaveBeenCalled();
    expect(harness.editor.value()).toContain("!inkbook[[drawings/page.svg]]");
    expect(harness.trashFile).not.toHaveBeenCalled();
  });

  it("refuses file deletion while metadata is unresolved", async () => {
    const harness = createHarness({ metadataResolved: false });

    const result = await harness.actions.deleteEmbed("drawings/page.svg");

    expect(result).toEqual({
      kind: "unavailable",
      reason: "metadata-unresolved",
    } satisfies DeleteEmbedOutcome);
    expect(harness.confirm).not.toHaveBeenCalled();
    expect(harness.editor.value()).toBe("!inkbook[[drawings/page.svg]]");
    expect(harness.trashFile).not.toHaveBeenCalled();
  });

  it("removes only the embed when other resolved references remain", async () => {
    const harness = createHarness({ references: 2 });
    harness.confirm.mockReturnValueOnce(true);

    const result = await harness.actions.deleteEmbed("drawings/page.svg");

    expectRemovedWithoutTrash(harness, result);
    expect(harness.confirm).toHaveBeenCalledTimes(1);
  });

  it("offers recoverable trash only when this is the sole resolved reference", async () => {
    const harness = createHarness({ references: 1 });
    harness.confirm.mockReturnValueOnce(true).mockReturnValueOnce(true);

    const result = await harness.actions.deleteEmbed("drawings/page.svg");

    expect(result).toEqual({ fileDeleted: true, kind: "deleted" } satisfies DeleteEmbedOutcome);
    expect(harness.editor.value()).toBe("");
    expect(harness.trashFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "drawings/page.svg" }),
    );
  });
});

describe("Obsidian invoking embed identity", () => {
  it("copies the invoking embed Markdown when the file is referenced more than once", async () => {
    const first = "!inkbook[[drawings/page.svg|First]]";
    const second = "!inkbook[[drawings/page.svg|Second]]";
    const harness = createHarness({ documentText: `${first}\n${second}`, references: 2 });
    const from = first.length + 1;

    const result = await harness.actions.copyEmbed({
      documentId: "drawings/page.svg",
      from,
      kind: "live-preview",
      sourcePath: "notes/note.md",
      to: from + second.length,
    });

    expect(result).toEqual({ kind: "copied", markdown: second });
    expect(harness.writeText).toHaveBeenCalledWith(second);
  });

  it("deletes only the invoking embed when the active note contains duplicate references", async () => {
    const first = "!inkbook[[drawings/page.svg|First]]";
    const second = "!inkbook[[drawings/page.svg|Second]]";
    const harness = createHarness({ documentText: `${first}\n${second}`, references: 2 });
    harness.confirm.mockReturnValueOnce(true);

    const result = await harness.actions.deleteEmbed({
      documentId: "drawings/page.svg",
      from: 0,
      kind: "live-preview",
      sourcePath: "notes/note.md",
      to: first.length,
    });

    expect(result).toEqual({ fileDeleted: false, kind: "deleted" });
    expect(harness.editor.value()).toBe(second);
    expect(harness.trashFile).not.toHaveBeenCalled();
  });
});

describe("Obsidian embed deletion race handling", () => {
  it("rechecks resolved source-aware references after confirmation before trashing", async () => {
    const harness = createHarness({ references: 1 });
    harness.confirm.mockReturnValueOnce(true).mockImplementationOnce(() => {
      harness.metadataCache.resolvedLinks["notes/other.md"] = {
        "drawings/page.svg": 1,
      };
      return true;
    });

    const result = await harness.actions.deleteEmbed("drawings/page.svg");

    expectRemovedWithoutTrash(harness, result);
  });

  it("fails closed when metadata becomes unresolved during confirmation", async () => {
    const harness = createHarness({ references: 1 });
    harness.confirm.mockReturnValueOnce(true).mockImplementationOnce(() => {
      harness.setMetadataResolved(false);
      return true;
    });

    const result = await harness.actions.deleteEmbed("drawings/page.svg");

    expect(result).toEqual({ kind: "unavailable", reason: "metadata-unresolved" });
    expect(harness.editor.value()).toBe("!inkbook[[drawings/page.svg]]");
    expect(harness.trashFile).not.toHaveBeenCalled();
  });

  it("preserves the embed when the user cancels the first confirmation", async () => {
    const harness = createHarness();
    harness.confirm.mockReturnValue(false);

    const result = await harness.actions.deleteEmbed("drawings/page.svg");

    expect(result).toEqual({ kind: "cancelled", stage: "embed" } satisfies DeleteEmbedOutcome);
    expect(harness.editor.value()).toBe("!inkbook[[drawings/page.svg]]");
    expect(harness.trashFile).not.toHaveBeenCalled();
  });

  it("removes the embed but keeps the file when the optional trash choice is canceled", async () => {
    const harness = createHarness({ references: 1 });
    harness.confirm.mockReturnValueOnce(true).mockReturnValueOnce(false);

    const result = await harness.actions.deleteEmbed("drawings/page.svg");

    expectRemovedWithoutTrash(harness, result);
  });
});

function readingActionHarness() {
  const first = "First\n!inkbook[[drawings/page.svg|First]]";
  const second = "Second\n!inkbook[[drawings/page.svg|Second]]";
  const harness = createHarness({ documentText: `${first}\n\n${second}` });
  const reference: ReadingViewEmbedReference = {
    documentId: "drawings/page.svg",
    kind: "reading-view",
    markdown: "!inkbook[[drawings/page.svg|Second]]",
    section: { lineEnd: 8, lineStart: 7, text: second },
    sectionFrom: second.indexOf("!inkbook[["),
    sectionTo: second.length,
    sourcePath: "notes/note.md",
  };
  return { first, harness, reference, second };
}

describe("Obsidian Reading-view embed actions", () => {
  it("copies exactly the invoking embed from one uniquely re-resolved section", async () => {
    const { harness, reference } = readingActionHarness();

    await expect(harness.actions.copyEmbed(reference)).resolves.toEqual({
      kind: "copied",
      markdown: reference.markdown,
    });
    expect(harness.writeText).toHaveBeenCalledWith(reference.markdown);
    expect(harness.read).toHaveBeenCalledOnce();
  });

  it("deletes only the invoking Reading-view embed through guarded Vault.process", async () => {
    const { first, harness, reference, second } = readingActionHarness();
    harness.confirm.mockReturnValueOnce(true);

    await expect(harness.actions.deleteEmbed(reference)).resolves.toEqual({
      fileDeleted: false,
      kind: "deleted",
    });
    expect(harness.vaultText()).toBe(`${first}\n\nSecond`);
    expect(harness.editor.value()).toBe(`${first}\n\n${second}`);
    expect(harness.process).toHaveBeenCalledOnce();
  });

  it("fails closed when identical Reading-view sections make the caller ambiguous", async () => {
    const section = "!inkbook[[drawings/page.svg|Same]]";
    const harness = createHarness({ documentText: `${section}\n${section}` });
    const reference: ReadingViewEmbedReference = {
      documentId: "drawings/page.svg",
      kind: "reading-view",
      markdown: section,
      section: { lineEnd: 2, lineStart: 2, text: section },
      sectionFrom: 0,
      sectionTo: section.length,
      sourcePath: "notes/note.md",
    };

    await expect(harness.actions.copyEmbed(reference)).resolves.toEqual({
      kind: "unavailable",
      reason: "embed-not-found",
    });
    await expect(harness.actions.deleteEmbed(reference)).resolves.toEqual({
      kind: "unavailable",
      reason: "embed-not-found",
    });
    expect(harness.writeText).not.toHaveBeenCalled();
    expect(harness.process).not.toHaveBeenCalled();
  });

  it("fails closed when the Reading-view section becomes stale during confirmation", async () => {
    const { harness, reference } = readingActionHarness();
    harness.confirm.mockImplementationOnce(() => {
      harness.setVaultText("# Replaced while confirming");
      return true;
    });

    await expect(harness.actions.deleteEmbed(reference)).resolves.toEqual({
      kind: "unavailable",
      reason: "embed-not-found",
    });
    expect(harness.process).not.toHaveBeenCalled();
    expect(harness.vaultText()).toBe("# Replaced while confirming");
  });
});

describe("Obsidian Live Preview recovery target replacement", () => {
  it("replaces only the exact invoking Live Preview range through the active Editor", async () => {
    const first = "!inkbook[[drawings/page.svg|First]]";
    const second = "!inkbook[[drawings/page.svg|Second]]";
    const harness = createHarness({ documentText: `${first}\n${second}` });
    const from = first.length + 1;
    const reference: LivePreviewEmbedReference = {
      documentId: "drawings/page.svg",
      from,
      kind: "live-preview",
      sourcePath: "notes/note.md",
      to: from + second.length,
    };

    await expect(
      harness.actions.replaceEmbedTarget(reference, "drawings/recovered.svg"),
    ).resolves.toBe(true);
    expect(harness.editor.value()).toBe(`${first}\n!inkbook[[drawings/recovered.svg]]`);
    expect(harness.process).not.toHaveBeenCalled();
  });

  it("fails closed for a stale Live Preview range or a different active source", async () => {
    const harness = createHarness();
    const reference = livePreviewReference({ sourcePath: "notes/other.md" });

    await expect(
      harness.actions.replaceEmbedTarget(reference, "drawings/recovered.svg"),
    ).resolves.toBe(false);
    await expect(
      harness.actions.replaceEmbedTarget(
        { ...reference, sourcePath: "notes/note.md", to: 20 },
        "drawings/recovered.svg",
      ),
    ).resolves.toBe(false);
    expect(harness.editor.value()).toBe("!inkbook[[drawings/page.svg]]");
  });

  it("fails closed when the Live Preview host exposes no active Editor", async () => {
    const harness = createHarness({ editorAvailable: false });
    const reference = livePreviewReference();

    await expect(harness.actions.copyEmbed(reference)).resolves.toEqual({
      kind: "unavailable",
      reason: "no-active-markdown-view",
    });
    expect(harness.writeText).not.toHaveBeenCalled();
  });

  it("fails closed when the invoking host has no owner Window", async () => {
    const harness = createHarness({ ownerWindowAvailable: false });
    const reference = livePreviewReference();

    await expect(harness.actions.copyEmbed(reference)).resolves.toEqual({
      kind: "unavailable",
      reason: "no-owner-window",
    });
    expect(harness.writeText).not.toHaveBeenCalled();
  });

  it("preserves Markdown when the recovery SVG cannot be resolved", async () => {
    const harness = createHarness();
    const reference = livePreviewReference();

    await expect(
      harness.actions.replaceEmbedTarget(reference, "drawings/missing.svg"),
    ).resolves.toBe(false);
    expect(harness.editor.value()).toBe("!inkbook[[drawings/page.svg]]");
  });
});

describe("Obsidian Reading-view recovery target replacement", () => {
  it("re-resolves one moved section and mutates it through Vault.process", async () => {
    const section = "Paragraph\n!inkbook[[drawings/page.svg|Drawing]]";
    const documentText = `New heading\n\n${section}\n\n!inkbook[[drawings/page.svg|Other]]`;
    const harness = createHarness({ documentText });
    const sectionFrom = section.indexOf("!inkbook[[");
    const reference: ReadingViewEmbedReference = {
      documentId: "drawings/page.svg",
      kind: "reading-view",
      markdown: "!inkbook[[drawings/page.svg|Drawing]]",
      section: { lineEnd: 13, lineStart: 12, text: section },
      sectionFrom,
      sectionTo: section.length,
      sourcePath: "notes/note.md",
    };

    await expect(
      harness.actions.replaceEmbedTarget(reference, "drawings/recovered.svg"),
    ).resolves.toBe(true);
    expect(harness.vaultText()).toBe(
      `New heading\n\nParagraph\n!inkbook[[drawings/recovered.svg]]\n\n!inkbook[[drawings/page.svg|Other]]`,
    );
    expect(harness.read).toHaveBeenCalledTimes(1);
    expect(harness.process).toHaveBeenCalledTimes(1);
    expect(harness.editor.value()).toBe(documentText);
  });

  it("rejects ambiguous and mismatched Reading-view section identities", async () => {
    const section = "!inkbook[[drawings/page.svg]]";
    const harness = createHarness({ documentText: `${section}\n${section}` });
    const reference: ReadingViewEmbedReference = {
      documentId: "drawings/page.svg",
      kind: "reading-view",
      markdown: section,
      section: { lineEnd: 4, lineStart: 4, text: section },
      sectionFrom: 0,
      sectionTo: section.length,
      sourcePath: "notes/note.md",
    };

    await expect(
      harness.actions.replaceEmbedTarget(reference, "drawings/recovered.svg"),
    ).resolves.toBe(false);
    await expect(
      harness.actions.replaceEmbedTarget(
        { ...reference, sectionTo: section.length - 1 },
        "drawings/recovered.svg",
      ),
    ).resolves.toBe(false);
    expect(harness.process).not.toHaveBeenCalled();
    expect(harness.vaultText()).toBe(`${section}\n${section}`);
  });

  it("rejects a Reading-view race without changing the newer Markdown", async () => {
    const section = "!inkbook[[drawings/page.svg]]";
    const harness = createHarness({ documentText: section });
    const reference = readingViewReference(section);
    harness.setBeforeProcess(() => harness.setVaultText(`# Concurrent edit\n${section}`));

    await expect(
      harness.actions.replaceEmbedTarget(reference, "drawings/recovered.svg"),
    ).resolves.toBe(false);
    expect(harness.vaultText()).toBe(`# Concurrent edit\n${section}`);
  });

  it("rechecks recovery currentness inside the Vault.process Markdown callback", async () => {
    const section = "!inkbook[[drawings/page.svg]]";
    const harness = createHarness({ documentText: section });
    const reference = readingViewReference(section);
    let current = true;
    harness.setBeforeProcess(() => {
      current = false;
    });

    await expect(
      harness.actions.replaceEmbedTarget(reference, "drawings/recovered.svg", () => current),
    ).resolves.toBe(false);

    expect(harness.process).toHaveBeenCalledOnce();
    expect(harness.vaultText()).toBe(section);
  });
});
