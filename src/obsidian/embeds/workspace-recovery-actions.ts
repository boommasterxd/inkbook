import type { WorkspaceEditorCoordinator } from "../../editor/session/workspace-editor-coordinator";
import {
  showHeadlessRecoveryNotice,
  type HeadlessRecoveryActions,
  type HeadlessRecoveryNotice,
} from "./recovery-notice";
import type { WorkspaceFeedbackRouter } from "./workspace-feedback-router";

export function createHeadlessRecoveryActions(
  coordinator: WorkspaceEditorCoordinator,
  reportSavedPath: (savedPath: string) => void,
): HeadlessRecoveryActions {
  return {
    reloadExternal: async () => (await coordinator.resolveRecovery("reload-external")).confirmed,
    retry: () => coordinator.retryRecovery(),
    saveLocalCopy: async () =>
      (
        await coordinator.resolveRecovery("save-local-copy", {
          reportSavedPath,
        })
      ).confirmed,
  };
}

export function showWorkspaceHeadlessRecovery(options: {
  readonly coordinator: WorkspaceEditorCoordinator;
  readonly documentId: string;
  readonly feedback: WorkspaceFeedbackRouter;
  readonly owningWindow: () => Window;
}): HeadlessRecoveryNotice {
  const actions = createHeadlessRecoveryActions(options.coordinator, () =>
    options.feedback.showRecoveryCopySaved(options.documentId),
  );
  return showHeadlessRecoveryNotice(
    options.documentId,
    actions,
    () => options.owningWindow().document,
  );
}
