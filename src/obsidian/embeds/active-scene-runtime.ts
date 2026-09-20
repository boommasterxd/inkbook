import type { SvgSceneRenderer } from "../../rendering/scene/index";
import type { BrowserScrollElement } from "../scrolling/index";
import type { ActiveEditorController } from "./active-editor/controller";
import { ActiveScenePreviewHandoff } from "./active-scene-handoff";
import { createActiveSceneChromeElements } from "./active-scene-chrome";
import { bindActiveSceneScrollOwner, type ActiveSceneScrollBinding } from "./active-scene-scroll";
import type { ActiveInkbookSceneOptions } from "./active-scene-types";
import { TransitionScrollStability } from "./transition-scroll-stability";

export function bindSceneScrollOwner(
  scrollOwner: BrowserScrollElement,
  ownerWindow: Window,
  options: ActiveInkbookSceneOptions,
  renderer: SvgSceneRenderer,
  controller: ActiveEditorController,
): ActiveSceneScrollBinding {
  return bindActiveSceneScrollOwner({
    initialOwner: scrollOwner,
    invalidate: () => renderer.invalidateLayout(),
    ownerWindow,
    ...(options.scrollOwner === undefined ? {} : { provider: options.scrollOwner }),
    root: options.root,
    transfer: (owner) => controller.transferScrollOwner(owner),
  });
}

function createSceneScrollStability(
  root: HTMLElement,
  ownerWindow: Window,
  owner: () => BrowserScrollElement,
  rangeReserve: ActiveInkbookSceneOptions["scrollRangeReserve"],
): TransitionScrollStability {
  return new TransitionScrollStability({
    owner,
    ownerWindow,
    ...(rangeReserve === undefined ? {} : { rangeReserve }),
    root,
  });
}

export function createInitialSceneRuntime(
  options: ActiveInkbookSceneOptions,
  ownerWindow: Window,
  owner: () => BrowserScrollElement,
): {
  readonly elements: ReturnType<typeof createActiveSceneChromeElements>;
  readonly handoff: ActiveScenePreviewHandoff;
  readonly stability: TransitionScrollStability;
} {
  const stability = createSceneScrollStability(
    options.root,
    ownerWindow,
    owner,
    options.scrollRangeReserve,
  );
  const releaseInitialStability = stability.begin();
  try {
    options.root.classList.add("inkbook-root");
    options.root.dataset.inkbookMotion = options.deviceSettings.motion;
    const elements = createActiveSceneChromeElements(options.root);
    const handoff = createScenePreviewHandoff(
      elements.container,
      options,
      stability,
      releaseInitialStability,
    );
    return { elements, handoff, stability };
  } catch (error: unknown) {
    releaseInitialStability();
    stability.dispose();
    throw error;
  }
}

function createScenePreviewHandoff(
  container: HTMLElement,
  options: ActiveInkbookSceneOptions,
  stability: TransitionScrollStability,
  initialScrollStabilityRelease: () => void,
): ActiveScenePreviewHandoff {
  options.setPreviewBackgroundWait?.(options.model.waitForBackground?.bind(options.model));
  return new ActiveScenePreviewHandoff({
    ...(options.ensurePreviewReady === undefined
      ? {}
      : { ensurePreviewReady: options.ensurePreviewReady }),
    onDispose: () => options.setPreviewBackgroundWait?.(undefined),
    beginScrollStability: () => stability.begin(),
    container,
    initialScrollStabilityRelease,
    motion: options.deviceSettings.motion,
    preview: options.preview,
    ...(options.initialEntrance === undefined ? {} : { initialEntrance: options.initialEntrance }),
    root: options.root,
    ...(options.setPreviewAspectRatio === undefined
      ? {}
      : { setPreviewAspectRatio: options.setPreviewAspectRatio }),
    ...(options.refreshPreview === undefined ? {} : { refreshPreview: options.refreshPreview }),
    ...(options.setPreviewSource === undefined
      ? {}
      : { setPreviewSource: options.setPreviewSource }),
  });
}
