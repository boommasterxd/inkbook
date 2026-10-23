import type { ActiveInkbookScene } from "../active-scene/active-scene";
import type { PresentationAttachment } from "../presentation/presentation-port";
import type { PresentationOperationFeedbackHandle } from "../presentation/presentation-operation-feedback";
import { showLoadRecoveryPanel } from "./recovery-notice";
import type { AttachedRecoveryPanel } from "./recovery-notice";
import type { InkbookFeedbackCode } from "../../feedback";
import type { ActivationOutcome } from "../../../editor/session/workspace-editor-coordinator-types";
import type { PersistedDocumentIdentity } from "../../../editor/session/session-port";

export type WorkspaceLoadFeedbackCode = Extract<
  InkbookFeedbackCode,
  "drawing-load-failed" | "drawing-version-changed" | "editor-start-failed"
>;

export interface WorkspaceActivation {
  autoActivationAttempt: number | undefined;
  readonly feedback: PresentationOperationFeedbackHandle | undefined;
  readonly release: () => void;
}

export interface WorkspaceMountedPresentation {
  activation?: WorkspaceActivation;
  initialLoading?: { readonly feedback: PresentationOperationFeedbackHandle; presented: boolean };
  readonly attachment: PresentationAttachment;
  disposeScheme: (() => void) | undefined;
  readonly feedback: import("../presentation/presentation-operation-feedback").PresentationOperationFeedback;
  loadError: AttachedRecoveryPanel | undefined;
  recovery: AttachedRecoveryPanel | undefined;
  savingFeedback: PresentationOperationFeedbackHandle | undefined;
  scene: ActiveInkbookScene | undefined;
}

export function handleWorkspaceActivationFailure(
  outcome: Exclude<ActivationOutcome, { readonly kind: "activated" }>,
  options: {
    readonly failAutoActivation: () => void;
    readonly refreshPreview: (identity: PersistedDocumentIdentity) => void;
    readonly setState: (state: "load-error" | "locked") => void;
    readonly showLoadError: (code: WorkspaceLoadFeedbackCode) => void;
  },
): void {
  options.failAutoActivation();
  const code =
    outcome.kind === "source-changed"
      ? "drawing-version-changed"
      : outcome.kind === "load-error"
        ? "drawing-load-failed"
        : undefined;
  options.setState(code === undefined ? "locked" : "load-error");
  if (outcome.kind === "source-changed") options.refreshPreview(outcome.actualSourceIdentity);
  if (code !== undefined) options.showLoadError(code);
}

export function showWorkspaceLoadRecovery(options: {
  readonly activate: () => void;
  readonly discard: () => void;
  readonly isCurrent: () => boolean;
  readonly mounted: WorkspaceMountedPresentation;
  readonly code: WorkspaceLoadFeedbackCode;
}): void {
  if (!options.isCurrent()) return;
  const mounted = options.mounted;
  mounted.loadError?.close();
  if (typeof mounted.attachment.root.createDiv !== "function") return;
  const panel = showLoadRecoveryPanel(
    mounted.attachment.root,
    {
      discard: () => {
        options.discard();
        return true;
      },
      retry: options.activate,
    },
    () => {
      if (mounted.loadError === panel) mounted.loadError = undefined;
    },
    options.code,
  );
  mounted.loadError = panel;
}
