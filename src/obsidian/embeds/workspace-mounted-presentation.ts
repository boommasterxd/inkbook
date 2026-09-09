import type { InkbookDeviceSettingsV2 } from "../../domain/settings/types";

import type { PresentationAttachment } from "./presentation-port";
import { PresentationOperationFeedback } from "./presentation-operation-feedback";
import type { WorkspaceMountedPresentation } from "./workspace-load-recovery";
import type { WorkspaceRuntimeLifecycle } from "./workspace-runtime-lifecycle";

export function createWorkspaceMountedPresentation(
  attachment: PresentationAttachment,
): WorkspaceMountedPresentation {
  return {
    attachment,
    disposeScheme: undefined,
    feedback: new PresentationOperationFeedback(attachment.root),
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

export function updateWorkspaceMountedSettings(
  presentations: Iterable<WorkspaceMountedPresentation>,
  settings: InkbookDeviceSettingsV2,
): void {
  for (const mounted of presentations) {
    mounted.attachment.root.dataset.inkbookMotion = settings.motion;
    mounted.scene?.updateDeviceSettings(settings);
  }
}
