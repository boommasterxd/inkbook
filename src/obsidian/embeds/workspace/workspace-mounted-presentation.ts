import type { InkbookDeviceSettingsV2 } from "../../../domain/settings/types";
import type { Localization } from "../../../domain/localization";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { AttachmentIdentity } from "../../../editor/session/session-state";

import {
  presentationAttachmentKey,
  type PresentationAttachment,
} from "../presentation/presentation-port";
import {
  PresentationOperationFeedback,
  type PresentationOperationFeedbackHandle,
} from "../presentation/presentation-operation-feedback";
import type { WorkspaceMountedPresentation } from "./workspace-load-recovery";

export function createWorkspacePresentationStateSetter(
  presentations: ReadonlyMap<string, WorkspaceMountedPresentation>,
): (
  attachment: AttachmentIdentity,
  state: string,
  feedback?: PresentationOperationFeedbackHandle,
) => void {
  return (attachment, state, feedback) => {
    if (state === "active") feedback?.finish();
    else feedback?.finish("immediate");
    const mounted = presentations.get(presentationAttachmentKey(attachment));
    if (mounted !== undefined) mounted.attachment.root.dataset.inkbookState = state;
  };
}

export function createWorkspaceMountedPresentation(
  attachment: PresentationAttachment,
  workScheduler: WorkScheduler,
  localization?: Localization,
): WorkspaceMountedPresentation {
  return {
    attachment,
    disposeScheme: undefined,
    feedback: new PresentationOperationFeedback(
      attachment.root,
      () => attachment.initialEntrance?.showLoading(),
      workScheduler,
      localization,
    ),
    loadError: undefined,
    recovery: undefined,
    savingFeedback: undefined,
    scene: undefined,
  };
}

export function resumeInitialWorkspacePreview(
  mounted: WorkspaceMountedPresentation | undefined,
): void {
  mounted?.attachment.initialEntrance?.resumePreview();
}

export function updateWorkspaceMountedSettings(
  presentations: Iterable<WorkspaceMountedPresentation>,
  settings: InkbookDeviceSettingsV2,
): void {
  for (const mounted of presentations) {
    mounted.attachment.root.dataset.inkbookMotion = settings.motion;
    mounted.scene?.updateDeviceSettings(settings);
  }
}

export function disposeWorkspaceMountedPresentations(
  presentations: Iterable<WorkspaceMountedPresentation>,
  retainScenes = false,
): void {
  for (const mounted of presentations) {
    if (retainScenes && mounted.scene !== undefined) continue;
    mounted.disposeScheme?.();
    mounted.activation?.release();
    mounted.feedback.dispose();
    mounted.loadError?.close();
    mounted.recovery?.close();
    mounted.scene?.dispose();
    mounted.scene = undefined;
    mounted.attachment.root.dataset.inkbookState = "locked";
  }
}

/** Keep the last painted scene until a connected presentation can show its safe preview. */
export function releaseWorkspaceScene(
  mounted: WorkspaceMountedPresentation,
  options: {
    readonly prepareRelease?: (release: () => void, failed: () => void) => void;
    readonly waitForPreview: boolean;
    readonly onLocked: () => void;
    readonly onFailure: () => void;
  },
): void {
  const scene = mounted.scene;
  const activation = mounted.activation;
  const current = () => mounted.scene === scene && mounted.activation === activation;
  const finish = () => {
    if (!current()) return;
    scene?.dispose();
    mounted.scene = undefined;
    options.onLocked();
  };
  const release = () => {
    if (scene === undefined || !options.waitForPreview) {
      finish();
      return;
    }
    scene.disableInput();
    void scene.finishLock().then(finish, () => {
      if (current()) options.onFailure();
    });
  };
  if (options.prepareRelease !== undefined) {
    scene?.disableInput();
    options.prepareRelease(release, options.onFailure);
  } else release();
}
