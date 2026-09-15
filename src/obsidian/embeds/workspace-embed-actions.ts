import type { CopyEmbedOutcome, DeleteEmbedOutcome } from "../commands";
import type { InkbookFeedbackCode } from "../feedback";
import type { PresentationEmbedReference, PresentationRemoval } from "./presentation-port";

interface WorkspaceEmbedActionPort {
  copyEmbed(reference: PresentationEmbedReference): Promise<CopyEmbedOutcome>;
  deleteEmbed(
    reference: PresentationEmbedReference,
    removal?: PresentationRemoval,
  ): Promise<DeleteEmbedOutcome>;
}

interface MarkdownHistoryPort {
  recordMarkdownHistory(): void;
}

export interface WorkspaceEmbedActionFeedbackPort {
  show(code: InkbookFeedbackCode): void;
}

function showFeedback(feedback: WorkspaceEmbedActionFeedbackPort, code: InkbookFeedbackCode): void {
  try {
    feedback.show(code);
  } catch {
    // A host notification failure must not change the completed data operation.
  }
}

function reportCopyFailure(
  outcome: Exclude<CopyEmbedOutcome, { readonly kind: "copied" }>,
  feedback: WorkspaceEmbedActionFeedbackPort,
): void {
  const code =
    outcome.kind === "unavailable" && outcome.reason === "clipboard-unavailable"
      ? "embed-copy-clipboard-unavailable"
      : "embed-copy-failed";
  showFeedback(feedback, code);
}

function reportDeleteFailure(
  outcome: Exclude<DeleteEmbedOutcome, { readonly kind: "cancelled" | "deleted" }>,
  feedback: WorkspaceEmbedActionFeedbackPort,
): void {
  if (outcome.kind === "failed") {
    showFeedback(feedback, "embed-delete-file-kept");
    return;
  }
  const code =
    outcome.reason === "metadata-unresolved"
      ? "embed-delete-references-unavailable"
      : outcome.reason === "editor-changed"
        ? "embed-delete-note-changed"
        : "embed-delete-failed";
  showFeedback(feedback, code);
}

export async function copyWorkspaceEmbed(
  actions: WorkspaceEmbedActionPort,
  reference: PresentationEmbedReference,
  feedback: WorkspaceEmbedActionFeedbackPort,
): Promise<void> {
  try {
    const outcome = await actions.copyEmbed(reference);
    if (outcome.kind !== "copied") reportCopyFailure(outcome, feedback);
  } catch {
    showFeedback(feedback, "embed-copy-failed");
  }
}

export async function deleteWorkspaceEmbed(options: {
  readonly actions: WorkspaceEmbedActionPort;
  readonly isCurrent: () => boolean;
  readonly reference: PresentationEmbedReference;
  readonly removal?: PresentationRemoval;
  readonly scene: MarkdownHistoryPort;
  readonly feedback: WorkspaceEmbedActionFeedbackPort;
}): Promise<void> {
  const feedback = options.feedback;
  try {
    const outcome = await options.actions.deleteEmbed(options.reference, options.removal);
    if (outcome.kind === "deleted" && options.isCurrent()) {
      options.scene.recordMarkdownHistory();
    } else if (outcome.kind !== "cancelled" && outcome.kind !== "deleted") {
      reportDeleteFailure(outcome, feedback);
    }
  } catch {
    showFeedback(feedback, "embed-delete-failed");
  }
}
