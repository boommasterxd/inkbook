import { describe, expect, it, vi } from "vitest";

import {
  copyWorkspaceEmbed,
  deleteWorkspaceEmbed,
} from "../../../../src/obsidian/embeds/workspace-embed-actions";
import type { CopyEmbedOutcome, DeleteEmbedOutcome } from "../../../../src/obsidian/commands";
import type { LivePreviewEmbedReference } from "../../../../src/obsidian/embeds/presentation-port";

const reference: LivePreviewEmbedReference = {
  documentId: "drawings/page.svg",
  from: 0,
  kind: "live-preview",
  sourcePath: "notes/page.md",
  to: 21,
};

function actionHarness(deleteKind: "cancelled" | "deleted") {
  const copyEmbed = vi.fn(async (): Promise<CopyEmbedOutcome> => ({
    kind: "copied" as const,
    markdown: reference.documentId,
  }));
  const deleteEmbed = vi.fn(async (): Promise<DeleteEmbedOutcome> =>
    deleteKind === "deleted"
      ? { fileDeleted: false, kind: "deleted" as const }
      : { kind: "cancelled" as const, stage: "embed" as const },
  );
  const recordMarkdownHistory = vi.fn();
  const show = vi.fn();
  return { actions: { copyEmbed, deleteEmbed }, feedback: { show }, recordMarkdownHistory, show };
}

describe("workspace embed Markdown history", () => {
  it("does not record a Markdown marker for copy", async () => {
    const harness = actionHarness("deleted");

    await copyWorkspaceEmbed(harness.actions, reference, harness.feedback);

    expect(harness.actions.copyEmbed).toHaveBeenCalledWith(reference);
    expect(harness.recordMarkdownHistory).not.toHaveBeenCalled();
  });

  it("does not record a Markdown marker for a cancelled delete", async () => {
    const harness = actionHarness("cancelled");

    await deleteWorkspaceEmbed({
      actions: harness.actions,
      isCurrent: () => true,
      feedback: harness.feedback,
      reference,
      scene: harness,
    });

    expect(harness.recordMarkdownHistory).not.toHaveBeenCalled();
    expect(harness.show).not.toHaveBeenCalled();
  });

  it("records one marker only after a successful current delete", async () => {
    const harness = actionHarness("deleted");

    await deleteWorkspaceEmbed({
      actions: harness.actions,
      isCurrent: () => true,
      feedback: harness.feedback,
      reference,
      scene: harness,
    });

    expect(harness.recordMarkdownHistory).toHaveBeenCalledOnce();
  });

  it("does not record a late successful delete for a stale scene", async () => {
    const harness = actionHarness("deleted");

    await deleteWorkspaceEmbed({
      actions: harness.actions,
      isCurrent: () => false,
      feedback: harness.feedback,
      reference,
      scene: harness,
    });

    expect(harness.recordMarkdownHistory).not.toHaveBeenCalled();
  });
});

describe("workspace embed action feedback", () => {
  it("reports an uncertain reference check without recording history", async () => {
    const harness = actionHarness("deleted");
    harness.actions.deleteEmbed.mockResolvedValueOnce({
      kind: "unavailable",
      reason: "metadata-unresolved",
    });

    await deleteWorkspaceEmbed({
      actions: harness.actions,
      isCurrent: () => true,
      feedback: harness.feedback,
      reference,
      scene: harness,
    });

    expect(harness.show).toHaveBeenCalledWith("embed-delete-references-unavailable");
    expect(harness.recordMarkdownHistory).not.toHaveBeenCalled();
  });

  it("reports a failed Markdown edit and preserves history", async () => {
    const harness = actionHarness("deleted");
    harness.actions.deleteEmbed.mockResolvedValueOnce({
      kind: "unavailable",
      reason: "editor-changed",
    });

    await deleteWorkspaceEmbed({
      actions: harness.actions,
      isCurrent: () => true,
      feedback: harness.feedback,
      reference,
      scene: harness,
    });

    expect(harness.show).toHaveBeenCalledWith("embed-delete-note-changed");
    expect(harness.recordMarkdownHistory).not.toHaveBeenCalled();
  });

  it("reports an incomplete delete when recoverable trash fails", async () => {
    const harness = actionHarness("deleted");
    harness.actions.deleteEmbed.mockResolvedValueOnce({
      error: new Error("trash failed"),
      kind: "failed",
    });

    await deleteWorkspaceEmbed({
      actions: harness.actions,
      isCurrent: () => true,
      feedback: harness.feedback,
      reference,
      scene: harness,
    });

    expect(harness.show).toHaveBeenCalledWith("embed-delete-file-kept");
    expect(harness.recordMarkdownHistory).not.toHaveBeenCalled();
  });

  it("reports rejected copy and delete operations without leaking the rejection", async () => {
    const harness = actionHarness("deleted");
    harness.actions.copyEmbed.mockRejectedValueOnce(new Error("clipboard failed"));
    harness.actions.deleteEmbed.mockRejectedValueOnce(new Error("edit failed"));

    await copyWorkspaceEmbed(harness.actions, reference, harness.feedback);
    await deleteWorkspaceEmbed({
      actions: harness.actions,
      isCurrent: () => true,
      feedback: harness.feedback,
      reference,
      scene: harness,
    });

    expect(harness.show.mock.calls).toEqual([["embed-copy-failed"], ["embed-delete-failed"]]);
  });
});
