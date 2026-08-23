import type { WorkspaceEditorCoordinator } from "../../editor/session/workspace-editor-coordinator";
import type { HeadlessRecoveryActions } from "./recovery-notice";

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
