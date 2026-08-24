import type { ActiveInkbookScene } from "./active-scene";
import type { PresentationAttachment } from "./presentation-port";
import type { PresentationOperationFeedbackHandle } from "./presentation-operation-feedback";
import { showLoadRecoveryPanel } from "./recovery-notice";

export interface WorkspaceMountedPresentation {
  readonly attachment: PresentationAttachment;
  disposeScheme: (() => void) | undefined;
  readonly feedback: import("./presentation-operation-feedback").PresentationOperationFeedback;
  loadError: HTMLElement | undefined;
  recovery: HTMLElement | undefined;
  savingFeedback: PresentationOperationFeedbackHandle | undefined;
  scene: ActiveInkbookScene | undefined;
}

export function showWorkspaceLoadRecovery(options: {
  readonly activate: () => void;
  readonly discard: () => void;
  readonly isCurrent: () => boolean;
  readonly mounted: WorkspaceMountedPresentation;
}): void {
  if (!options.isCurrent()) return;
  const mounted = options.mounted;
  mounted.loadError?.remove();
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
  );
  mounted.loadError = panel;
}
