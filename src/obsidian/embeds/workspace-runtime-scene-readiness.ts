import type { WorkspaceEditorCoordinatorSnapshot } from "../../editor/session/workspace-editor-coordinator-types";
import type { ColorSchemeBroadcaster } from "../theme/color-scheme";
import { presentationAttachmentKey, type PresentationAttachment } from "./presentation-port";
import type { ActiveInkbookScene } from "./active-scene";
import type { WorkspaceActivation, WorkspaceMountedPresentation } from "./workspace-load-recovery";
import {
  createWorkspaceActiveScene,
  type WorkspaceActiveSceneOptions,
} from "./workspace-active-scene";

interface SceneMount {
  disposeScheme: (() => void) | undefined;
  scene: ActiveInkbookScene | undefined;
}

function observeActiveSceneReadiness(options: {
  readonly isCurrent: () => boolean;
  readonly mounted: SceneMount;
  readonly onFailure: () => void;
  readonly onReady: () => void;
  readonly scene: ActiveInkbookScene;
}): Promise<void> {
  return options.scene.ready
    .then((ready) => {
      if (ready && options.isCurrent()) options.onReady();
    })
    .catch(() => {
      if (!options.isCurrent()) return;
      options.mounted.disposeScheme?.();
      options.mounted.disposeScheme = undefined;
      options.scene.dispose();
      options.mounted.scene = undefined;
      options.onFailure();
    });
}

export function mountWorkspaceActiveScene(
  options: WorkspaceActiveSceneOptions & {
    readonly mounted: SceneMount;
    readonly onFailure: () => void;
    readonly onReady: () => void;
    readonly colorScheme: ColorSchemeBroadcaster;
  },
): Promise<void> {
  const mounted = options.mounted;
  mounted.scene?.dispose();
  mounted.disposeScheme?.();
  const scene = createWorkspaceActiveScene(options);
  mounted.scene = scene;
  mounted.disposeScheme = options.colorScheme.subscribe((scheme) => scene.setScheme(scheme));
  return observeActiveSceneReadiness({
    ...options,
    scene,
    isCurrent: () => options.isCurrent(scene),
  });
}

export function isCurrentPresentationActivation(
  snapshot: WorkspaceEditorCoordinatorSnapshot,
  attachment: PresentationAttachment,
  sessionId: string,
): boolean {
  const current = snapshot.current;
  return (
    !snapshot.disposed &&
    current?.phase === "active" &&
    current.sessionId === sessionId &&
    current.documentId === attachment.documentId &&
    current.attachment !== undefined &&
    presentationAttachmentKey(current.attachment) === presentationAttachmentKey(attachment)
  );
}

export function beginWorkspaceActivation(
  mounted: WorkspaceMountedPresentation,
  autoActivationAttempt: number | undefined,
): WorkspaceActivation | undefined {
  if (mounted.activation !== undefined) {
    if (autoActivationAttempt !== undefined)
      mounted.activation.autoActivationAttempt = autoActivationAttempt;
    return undefined;
  }
  mounted.loadError?.close();
  mounted.loadError = undefined;
  const activation: WorkspaceActivation = {
    autoActivationAttempt,
    feedback: mounted.savingFeedback
      ? undefined
      : (mounted.initialLoading?.feedback ?? mounted.feedback.begin("loading")),
    release: () => {
      if (mounted.activation === activation) delete mounted.activation;
    },
  };
  delete mounted.initialLoading;
  mounted.activation = activation;
  return activation;
}

/** Initial insertion waits for width measurement; ordinary unlocking waits for the preview. */
export async function presentationActivationReady(
  attachment: PresentationAttachment,
): Promise<boolean> {
  return attachment.initialEntrance?.activationReady ?? attachment.whenPresented ?? true;
}
