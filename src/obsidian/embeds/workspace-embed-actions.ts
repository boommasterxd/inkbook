import { Notice } from "obsidian";

import type { CopyEmbedOutcome, DeleteEmbedOutcome } from "../commands";
import type { PresentationEmbedReference } from "./presentation-port";

interface WorkspaceEmbedActionPort {
  copyEmbed(reference: PresentationEmbedReference): Promise<CopyEmbedOutcome>;
  deleteEmbed(reference: PresentationEmbedReference): Promise<DeleteEmbedOutcome>;
}

interface MarkdownHistoryPort {
  recordMarkdownHistory(): void;
}

export interface WorkspaceEmbedActionNoticePort {
  show(message: string): void;
}

const DEFAULT_NOTICES: WorkspaceEmbedActionNoticePort = {
  show: (message) => {
    new Notice(message);
  },
};

function showNotice(notices: WorkspaceEmbedActionNoticePort, message: string): void {
  try {
    notices.show(message);
  } catch {
    // A host notification failure must not change the completed data operation.
  }
}

function reportCopyFailure(
  outcome: Exclude<CopyEmbedOutcome, { readonly kind: "copied" }>,
  notices: WorkspaceEmbedActionNoticePort,
): void {
  const message =
    outcome.kind === "unavailable" && outcome.reason === "clipboard-unavailable"
      ? "Inkbook could not copy the embed because the system clipboard is unavailable."
      : "Inkbook could not copy the embed.";
  showNotice(notices, message);
}

function reportDeleteFailure(
  outcome: Exclude<DeleteEmbedOutcome, { readonly kind: "cancelled" | "deleted" }>,
  notices: WorkspaceEmbedActionNoticePort,
): void {
  if (outcome.kind === "failed") {
    showNotice(
      notices,
      "Inkbook removed the embed but could not move the handwriting file to trash. The file was preserved.",
    );
    return;
  }
  const message =
    outcome.reason === "metadata-unresolved"
      ? "Inkbook could not verify whether the handwriting file has other references. Nothing was deleted."
      : outcome.reason === "editor-changed"
        ? "Inkbook could not delete the embed because the note changed. The handwriting file was preserved."
        : "Inkbook could not delete the embed. The handwriting file was preserved.";
  showNotice(notices, message);
}

export async function copyWorkspaceEmbed(
  actions: WorkspaceEmbedActionPort,
  reference: PresentationEmbedReference,
  notices: WorkspaceEmbedActionNoticePort = DEFAULT_NOTICES,
): Promise<void> {
  try {
    const outcome = await actions.copyEmbed(reference);
    if (outcome.kind !== "copied") reportCopyFailure(outcome, notices);
  } catch {
    showNotice(notices, "Inkbook could not copy the embed.");
  }
}

export async function deleteWorkspaceEmbed(options: {
  readonly actions: WorkspaceEmbedActionPort;
  readonly isCurrent: () => boolean;
  readonly reference: PresentationEmbedReference;
  readonly scene: MarkdownHistoryPort;
  readonly notices?: WorkspaceEmbedActionNoticePort;
}): Promise<void> {
  const notices = options.notices ?? DEFAULT_NOTICES;
  try {
    const outcome = await options.actions.deleteEmbed(options.reference);
    if (outcome.kind === "deleted" && options.isCurrent()) {
      options.scene.recordMarkdownHistory();
    } else if (outcome.kind !== "cancelled" && outcome.kind !== "deleted") {
      reportDeleteFailure(outcome, notices);
    }
  } catch {
    showNotice(notices, "Inkbook could not delete the embed. The handwriting file was preserved.");
  }
}
