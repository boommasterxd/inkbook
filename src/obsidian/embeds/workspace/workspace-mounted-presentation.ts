import type { InkbookDeviceSettingsV2 } from "../../../domain/settings/types";
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
import type { WorkspaceRuntimeLifecycle } from "./workspace-runtime-lifecycle";

export function createWorkspacePresentationStateSetter(
  presentations: ReadonlyMap<string, WorkspaceMountedPresentation>,
): (
  attachment: AttachmentIdentity,
  state: string,
  feedback?: PresentationOperationFeedbackHandle,
) => void {
  return (attachment, state, feedback) => {
    feedback?.finish();
    const mounted = presentations.get(presentationAttachmentKey(attachment));
    if (mounted !== undefined) mounted.attachment.root.dataset.inkbookState = state;
  };
}

export function createWorkspaceMountedPresentation(
  attachment: PresentationAttachment,
  workScheduler: WorkScheduler,
): WorkspaceMountedPresentation {
  return {
    attachment,
    disposeScheme: undefined,
    feedback: new PresentationOperationFeedback(
      attachment.root,
      () => attachment.initialEntrance?.showLoading(),
      workScheduler,
    ),
    loadError: undefined,
    recovery: undefined,
    savingFeedback: undefined,
    scene: undefined,
  };
}

/** Carries recognition feedback through presentation and any queued initial activation. */
export function startInitialWorkspaceLoading(
  mounted: WorkspaceMountedPresentation,
  lifecycle: Pick<WorkspaceRuntimeLifecycle, "hasPendingAutoActivation">,
): void {
  const attachment = mounted.attachment;
  if (attachment.loadingStartedAt === undefined) return;
  const initial = {
    feedback: mounted.feedback.begin("loading", attachment.loadingStartedAt),
    presented: false,
  };
  mounted.initialLoading = initial;
  void Promise.resolve(attachment.whenPresented ?? true).then((presented) => {
    if (mounted.initialLoading !== initial) return;
    initial.presented = true;
    if (!presented || !lifecycle.hasPendingAutoActivation(attachment))
      finishInitialWorkspaceLoading(mounted);
  });
}

export function finishInitialWorkspaceLoading(
  mounted: WorkspaceMountedPresentation | undefined,
): void {
  if (mounted?.initialLoading?.presented !== true) return;
  mounted.initialLoading.feedback.finish();
  delete mounted.initialLoading;
}

export function cancelInitialWorkspaceLoading(
  mounted: WorkspaceMountedPresentation | undefined,
): void {
  mounted?.attachment.initialEntrance?.resumePreview();
  finishInitialWorkspaceLoading(mounted);
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
): void {
  for (const mounted of presentations) {
    mounted.disposeScheme?.();
    mounted.activation?.release();
    mounted.feedback.dispose();
    mounted.loadError?.close();
    mounted.recovery?.close();
    mounted.scene?.dispose();
    mounted.attachment.root.dataset.inkbookState = "locked";
  }
}
