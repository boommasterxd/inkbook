import type { SvgSceneRenderer } from "../../rendering/scene/index";
import {
  browserScrollMetrics,
  createBrowserScrollDocumentPort,
  resolveScrollOwner,
  type BrowserScrollElement,
} from "../scrolling/index";
import type { ActiveEditorController } from "./active-editor/controller";
import type { ActiveEditorLayout } from "./active-editor/layout";
import type { ActiveEditorZoomLayoutUpdate } from "./active-editor/navigation-types";
import type { HostZoomScroll } from "./live-preview-zoom-scroll";
import { ActiveScenePreviewHandoff } from "./active-scene-handoff";
import { createActiveSceneChromeElements } from "./active-scene-chrome";
import { bindActiveSceneScrollOwner, type ActiveSceneScrollBinding } from "./active-scene-scroll";
import type { ActiveInkbookSceneOptions } from "./active-scene-types";
import { TransitionScrollStability } from "./transition-scroll-stability";

export function applyActiveSceneZoomLayout(
  layout: ActiveEditorLayout,
  update: ActiveEditorZoomLayoutUpdate,
  hostZoomScroll: HostZoomScroll | undefined,
  container: HTMLElement,
): number {
  const blockSize = layout.applyZoom(update);
  if (update.layout !== undefined && update.scrollTop !== undefined) {
    hostZoomScroll?.retain(update.layout.scrollOwner, update.scrollTop, {
      container,
      contentTop:
        (update.layout.containerBorderTop ?? update.layout.containerBounds.top) +
        update.layout.scrollTop,
    });
  } else hostZoomScroll?.cancel();
  return blockSize;
}

export function resolveActiveScrollOwner(root: HTMLElement): BrowserScrollElement {
  return (
    resolveScrollOwner(
      root,
      createBrowserScrollDocumentPort(root.ownerDocument),
      browserScrollMetrics,
    ) ?? root
  );
}

export function bindSceneScrollOwner(
  scrollOwner: BrowserScrollElement,
  ownerWindow: Window,
  options: ActiveInkbookSceneOptions,
  renderer: SvgSceneRenderer,
  controller: ActiveEditorController,
  reuseOwnScroll?: (owner: BrowserScrollElement) => boolean,
): ActiveSceneScrollBinding {
  return bindActiveSceneScrollOwner({
    initialOwner: scrollOwner,
    invalidate: () => renderer.invalidateLayout(),
    onScroll: () => controller.handleNativeScroll(),
    ...(reuseOwnScroll === undefined ? {} : { reuseOwnScroll }),
    ownerWindow,
    ...(options.scrollOwner === undefined ? {} : { provider: options.scrollOwner }),
    root: options.root,
    transfer: (owner) => {
      options.hostZoomScroll?.cancel();
      controller.transferScrollOwner(owner);
    },
  });
}

function createSceneScrollStability(
  root: HTMLElement,
  ownerWindow: Window,
  owner: () => BrowserScrollElement,
  rangeReserve: ActiveInkbookSceneOptions["scrollRangeReserve"],
  workScheduler: ActiveInkbookSceneOptions["workScheduler"],
): TransitionScrollStability {
  return new TransitionScrollStability({
    owner,
    ownerWindow,
    workScheduler,
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
    options.workScheduler,
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
    workScheduler: options.workScheduler,
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
