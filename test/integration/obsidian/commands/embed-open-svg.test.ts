import { describe, expect, it } from "vitest";

import type { LivePreviewEmbedReference } from "../../../../src/obsidian/embeds/presentation/presentation-port";
import { createHarness } from "./embed-actions-fixture";

const markdown = "!inkbook[[drawings/page.svg]]";

function liveReference(): LivePreviewEmbedReference {
  return {
    documentId: "drawings/page.svg",
    from: 0,
    kind: "live-preview",
    sourcePath: "notes/note.md",
    to: markdown.length,
  };
}

function readingReference() {
  return {
    documentId: "drawings/page.svg",
    kind: "reading-view" as const,
    markdown,
    section: { lineEnd: 0, lineStart: 0, text: markdown },
    sectionFrom: 0,
    sectionTo: markdown.length,
    sourcePath: "notes/note.md",
  };
}

describe("opening the invoking Inkbook SVG", () => {
  it.each([liveReference(), readingReference()])(
    "opens the exact current SVG in a new native tab from $kind without a clipboard",
    async (reference) => {
      const harness = createHarness({ editorAvailable: reference.kind === "live-preview" });
      Object.defineProperty(harness.ownerWindow.navigator, "clipboard", { value: undefined });

      await expect(harness.actions.openSvg(reference)).resolves.toEqual({
        kind: "opened",
        path: "drawings/page.svg",
      });

      expect(harness.getLeaf).toHaveBeenCalledExactlyOnceWith("tab");
      expect(harness.openFile).toHaveBeenCalledExactlyOnceWith(harness.target, { active: true });
      expect(harness.editor.value()).toBe(markdown);
      expect(harness.process).not.toHaveBeenCalled();
      expect(harness.confirm).not.toHaveBeenCalled();
    },
  );

  it("rejects a stale invoking range instead of opening another available SVG", async () => {
    const harness = createHarness({ documentText: "!inkbook[[drawings/recovered.svg]]" });

    await expect(harness.actions.openSvg(liveReference())).resolves.toEqual({
      kind: "unavailable",
      reason: "embed-not-found",
    });
    expect(harness.getLeaf).not.toHaveBeenCalled();
  });

  it.each([
    { stage: "before reference resolution", availableReads: 0 },
    { stage: "after reference resolution", availableReads: 2 },
  ])("rejects an SVG missing $stage without a fallback", async ({ availableReads }) => {
    const harness = createHarness();
    harness.getFileByPath.mockReturnValue(null);
    for (let read = 0; read < availableReads; read += 1) {
      harness.getFileByPath.mockReturnValueOnce(harness.target);
    }

    await expect(harness.actions.openSvg(liveReference())).resolves.toEqual({
      kind: "unavailable",
      reason: "document-not-found",
    });
    expect(harness.getFileByPath).toHaveBeenCalledTimes(availableReads + 1);
    expect(harness.getLeaf).not.toHaveBeenCalled();
  });

  it("rechecks the active source after asynchronous Reading-view resolution", async () => {
    const harness = createHarness();
    harness.read.mockImplementationOnce(async () => {
      harness.view.file = harness.target;
      return markdown;
    });

    await expect(harness.actions.openSvg(readingReference())).resolves.toEqual({
      kind: "unavailable",
      reason: "editor-changed",
    });
    expect(harness.getLeaf).not.toHaveBeenCalled();
  });

  it("does not open from a disposed action owner", async () => {
    const harness = createHarness();
    harness.actions.dispose();

    await expect(harness.actions.openSvg(liveReference())).resolves.toEqual({
      kind: "unavailable",
      reason: "editor-changed",
    });
    expect(harness.getLeaf).not.toHaveBeenCalled();
  });

  it("returns the native open failure without mutating the source", async () => {
    const harness = createHarness();
    const error = new Error("native-open-failed");
    harness.openFile.mockRejectedValueOnce(error);

    await expect(harness.actions.openSvg(liveReference())).resolves.toEqual({
      error,
      kind: "failed",
    });
    expect(harness.editor.value()).toBe(markdown);
    expect(harness.process).not.toHaveBeenCalled();
  });
});
