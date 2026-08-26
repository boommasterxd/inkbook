import type { ActiveInkbookScene } from "./active-scene";
import type { PresentationAttachment } from "./presentation-port";
import type { PresentationOperationFeedbackHandle } from "./presentation-operation-feedback";
import { showLoadRecoveryPanel } from "./recovery-notice";
import type { AttachedRecoveryPanel } from "./recovery-notice";
import type { InkbookFeedbackCode } from "../feedback";

export type WorkspaceLoadFeedbackCode = Extract<
  InkbookFeedbackCode,
  "drawing-load-failed" | "editor-start-failed"
>;

export interface WorkspaceMountedPresentation {
  readonly attachment: PresentationAttachment;
  disposeScheme: (() => void) | undefined;
  readonly feedback: import("./presentation-operation-feedback").PresentationOperationFeedback;
  loadError: AttachedRecoveryPanel | undefined;
  recovery: AttachedRecoveryPanel | undefined;
  savingFeedback: PresentationOperationFeedbackHandle | undefined;
  scene: ActiveInkbookScene | undefined;
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
