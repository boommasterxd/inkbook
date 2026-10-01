import type { PresentationAttachment } from "./presentation-port";
import { presentationAttachmentKey } from "./presentation-port";
import type { WorkspaceEditorCoordinatorSnapshot } from "../../editor/session/workspace-editor-coordinator-types";
import type { WorkspaceMountedPresentation } from "./workspace-load-recovery";
import type { InkbookCommandAction } from "../commands";

export function executeWorkspaceSceneAction(
  action: Exclude<InkbookCommandAction, "lock">,
  snapshot: WorkspaceEditorCoordinatorSnapshot,
  presentations: ReadonlyMap<string, WorkspaceMountedPresentation>,
): void {
  const scene = activeWorkspaceScene(snapshot, presentations);
  if (scene === undefined || !scene.isActionAvailable(action)) {
    throw new Error(`Inkbook action is unavailable: ${action}`);
  }
  scene.executeAction(action);
}

export function activeWorkspaceScene(
  snapshot: WorkspaceEditorCoordinatorSnapshot,
  presentations: ReadonlyMap<string, WorkspaceMountedPresentation>,
): WorkspaceMountedPresentation["scene"] {
  const attachment = snapshot.current?.attachment;
  return attachment === undefined
    ? undefined
    : presentations.get(presentationAttachmentKey(attachment))?.scene;
}

export function recordWorkspaceMarkdownHistory(
  snapshot: WorkspaceEditorCoordinatorSnapshot,
  presentations: ReadonlyMap<string, WorkspaceMountedPresentation>,
  sourcePath: string,
  pane: HTMLElement,
): void {
  const current = snapshot.current;
  if (current?.phase !== "active" || current.attachment === undefined) return;
  const mounted = presentations.get(presentationAttachmentKey(current.attachment));
  if (mounted !== undefined && ownsMarkdownEditorChange(mounted.attachment, sourcePath, pane)) {
    mounted.scene?.recordMarkdownHistory();
  }
}

export function ownsMarkdownEditorChange(
  attachment: PresentationAttachment,
  sourcePath: string,
  pane: HTMLElement,
): boolean {
  return (
    attachment.embedReference.sourcePath === sourcePath &&
    (pane === attachment.root || pane.contains(attachment.root))
  );
}
