import { describe, expect, it, vi } from "vitest";

import {
  copyWorkspaceEmbed,
  deleteWorkspaceEmbed,
  openWorkspaceEmbedSvg,
} from "../../../../../src/obsidian/embeds/workspace/workspace-embed-actions";
import type {
  CopyEmbedOutcome,
  DeleteEmbedOutcome,
  OpenSvgOutcome,
} from "../../../../../src/obsidian/commands";
import type { LivePreviewEmbedReference } from "../../../../../src/obsidian/embeds/presentation/presentation-port";

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
  it("deletes a locked embed without a scene and preserves its removal owner", async () => {
    const harness = actionHarness("deleted");
    const removal = { begin: vi.fn(async () => true), reset: vi.fn() };

    await deleteWorkspaceEmbed({
      actions: harness.actions,
      feedback: harness.feedback,
      isCurrent: () => true,
      reference,
      removal,
    });

    expect(harness.actions.deleteEmbed).toHaveBeenCalledExactlyOnceWith(reference, removal);
    expect(harness.show).not.toHaveBeenCalled();
    expect(harness.recordMarkdownHistory).not.toHaveBeenCalled();
  });

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

describe("workspace native SVG opening", () => {
  it("opens the invoking reference without success feedback", async () => {
    const actions = {
      openSvg: vi.fn(async (): Promise<OpenSvgOutcome> => ({
        kind: "opened",
        path: reference.documentId,
      })),
    };
    const feedback = { show: vi.fn() };

    await openWorkspaceEmbedSvg(actions, reference, feedback);

    expect(actions.openSvg).toHaveBeenCalledExactlyOnceWith(reference);
    expect(feedback.show).not.toHaveBeenCalled();
  });

  it.each<OpenSvgOutcome>([
    { kind: "unavailable", reason: "embed-not-found" },
    { kind: "failed", error: new Error("native open failed") },
  ])("reports an unsuccessful SVG action: $kind", async (outcome) => {
    const actions = { openSvg: vi.fn(async () => outcome) };
    const feedback = { show: vi.fn() };

    await openWorkspaceEmbedSvg(actions, reference, feedback);

    expect(feedback.show).toHaveBeenCalledExactlyOnceWith("embed-open-failed");
  });

  it("contains a rejected SVG action even if host feedback also fails", async () => {
    const actions = { openSvg: vi.fn(async () => Promise.reject(new Error("open rejected"))) };
    const feedback = {
      show: vi.fn(() => {
        throw new Error("notification failed");
      }),
    };

    await expect(openWorkspaceEmbedSvg(actions, reference, feedback)).resolves.toBeUndefined();
    expect(feedback.show).toHaveBeenCalledExactlyOnceWith("embed-open-failed");
  });
});

describe("workspace embed copy feedback", () => {
  it.each([
    {
      outcome: {
        kind: "unavailable",
        reason: "clipboard-unavailable",
      } satisfies CopyEmbedOutcome,
      code: "embed-copy-clipboard-unavailable",
    },
    {
      outcome: { kind: "failed", error: new Error("clipboard denied") } satisfies CopyEmbedOutcome,
      code: "embed-copy-failed",
    },
  ])("reports the copy failure to the invoking presentation: $code", async ({ outcome, code }) => {
    const harness = actionHarness("deleted");
    harness.actions.copyEmbed.mockResolvedValueOnce(outcome);
    await copyWorkspaceEmbed(harness.actions, reference, harness.feedback);
    expect(harness.show).toHaveBeenCalledExactlyOnceWith(code);
    expect(harness.recordMarkdownHistory).not.toHaveBeenCalled();
  });
});

describe("workspace embed delete feedback", () => {
  it("reports a stale locked embed without recording a Markdown history marker", async () => {
    const harness = actionHarness("deleted");
    harness.actions.deleteEmbed.mockResolvedValueOnce({
      kind: "unavailable",
      reason: "embed-not-found",
    });
    await deleteWorkspaceEmbed({
      actions: harness.actions,
      feedback: harness.feedback,
      isCurrent: () => false,
      reference,
    });
    expect(harness.show).toHaveBeenCalledExactlyOnceWith("embed-delete-failed");
    expect(harness.recordMarkdownHistory).not.toHaveBeenCalled();
  });

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
