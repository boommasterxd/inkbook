import { derivePageExtent, PAGE_WIDTH } from "../../domain/geometry/public";
import type { PageV1 } from "../../domain/schema/public";
import { applyAnchoredZoom, calculateZoomLimits, type ScrollBounds } from "../../editor/zoom/index";
import { TRANSITION_DURATIONS } from "../../rendering/motion/transitions";
import { measureElementBox } from "./active-editor/element-content-box";
import type { ActiveEditorViewState } from "./active-editor/navigation";

const LOCK_LAYOUT_DURATION_MS = 240;
const LOCK_PRESENTATION_DURATION_MS = Math.max(
  LOCK_LAYOUT_DURATION_MS,
  TRANSITION_DURATIONS.toolbarEnterExit,
);
const activeTransitions = new WeakMap<HTMLElement, LockedFitTransition>();

interface LockedFitLayoutOptions {
  readonly anchor: SceneLayoutAnchor | undefined;
  readonly applyResize: (update: SceneLayoutUpdate) => boolean;
  readonly beginScrollStability?: (minimumRangeReserve: number) => () => void;
  readonly container: HTMLElement;
  readonly maximumBottom: number | undefined;
  readonly oldViewState: ActiveEditorViewState;
  readonly page: PageV1;
  readonly reducedMotion: boolean;
  readonly restoreViewState: (state: ActiveEditorViewState) => boolean;
}

export interface LockedFitTransition {
  /** Applies the exact final camera and height once, synchronously. */
  finish(): void;
  /** Stops pending animation work without applying the locked target. */
  cancel(): void;
  /** Releases viewport stabilization after the editor-to-preview handoff. */
  releaseViewportStability(): void;
}

export function applyLockedFitLayout(options: LockedFitLayoutOptions): LockedFitTransition {
  const previous = activeTransitions.get(options.container);
  previous?.cancel();
  previous?.releaseViewportStability();
  const measurement = measureElementBox(options.container);
  const width = Math.max(1, measurement.contentBox.width);
  const fitZoom = width / PAGE_WIDTH;
  const lockedHeight = derivePageExtent(options.page, options.maximumBottom ?? null).lockedHeight;
  const transition = new LockLayoutTransition(options, {
    fitZoom,
    lockedHeight,
    oldBlockSize: Math.max(0, measurement.borderBox.height),
    verticalInsets: Math.max(0, measurement.borderBox.height - measurement.contentBox.height),
    width,
  });
  activeTransitions.set(options.container, transition);
  transition.start();
  transition.retainViewportStability(
    options.beginScrollStability?.(minimumLockRangeReserve(options.anchor, transition.target)),
  );
  return transition;
}

export function lockedPageAspectRatio(page: PageV1, maximumBottom: number | undefined): number {
  return PAGE_WIDTH / derivePageExtent(page, maximumBottom ?? null).lockedHeight;
}

interface SceneLayoutAnchor {
  readonly anchorViewportY: number;
  readonly embedTopInScrollContent: number;
  readonly oldScrollTop: number;
  readonly scrollBounds: ScrollBounds;
  readonly viewportWidth: number;
}

export interface SceneLayoutUpdate {
  readonly cameraX: number;
  readonly fitZoom: number;
  readonly scrollTop?: number;
  readonly zoom: number;
}

interface ActiveLayoutOptions {
  readonly anchor: SceneLayoutAnchor | undefined;
  readonly applyResize: (update: SceneLayoutUpdate) => boolean;
  readonly container: HTMLElement;
  readonly currentViewState: ActiveEditorViewState;
  readonly restoreViewState: (state: ActiveEditorViewState) => boolean;
  readonly targetBlockSize: string;
  readonly targetViewState: ActiveEditorViewState;
}

export function restoreActiveLayout(options: ActiveLayoutOptions): void {
  activeTransitions.get(options.container)?.cancel();
  const targetBlockSize = Number.parseFloat(options.targetBlockSize);
  const pageHeight = targetBlockSize / options.targetViewState.zoom;
  const measurement = measureElementBox(options.container);
  const anchored =
    Number.isFinite(pageHeight) && pageHeight >= 0
      ? resolveAnchoredLayout(
          { ...options, oldViewState: options.currentViewState },
          options.targetViewState,
          pageHeight,
          targetBlockSize,
          measurement.contentBox.width,
          measurement.borderBox.height,
        )
      : undefined;
  options.container.style.blockSize = options.targetBlockSize;
  if (Number.isFinite(pageHeight) && pageHeight >= 0) {
    applyResolvedLayout(options, options.targetViewState, anchored);
  } else {
    options.restoreViewState(options.targetViewState);
  }
}

interface LockTarget {
  readonly fitZoom: number;
  readonly lockedHeight: number;
  readonly oldBlockSize: number;
  readonly verticalInsets: number;
  readonly width: number;
}

class LockLayoutTransition implements LockedFitTransition {
  readonly #options: LockedFitLayoutOptions;
  readonly #ownerWindow: Window;
  readonly #startTime: number;
  readonly #target: LockTarget;
  #frame: number | undefined;
  #releaseViewportStability: (() => void) | undefined;
  #settled = false;

  public constructor(options: LockedFitLayoutOptions, target: LockTarget) {
    const ownerWindow = options.container.ownerDocument.defaultView;
    if (ownerWindow === null) throw new Error("The lock transition requires an owning window.");
    this.#options = options;
    this.#ownerWindow = ownerWindow;
    this.#startTime = ownerWindow.performance.now();
    this.#target = target;
    options.container.style.blockSize = `${String(target.oldBlockSize)}px`;
    options.container.setCssProps({ transition: "none" });
  }

  public get target(): LockTarget {
    return this.#target;
  }

  public start(): void {
    if (!this.#options.reducedMotion) this.#scheduleFrame();
  }

  public finish(): void {
    if (this.#settled) return;
    this.#cancelFrame();
    this.#apply(1);
    this.#settle();
  }

  public cancel(): void {
    if (this.#settled) return;
    this.#cancelFrame();
    this.#settle();
  }

  public releaseViewportStability(): void {
    const release = this.#releaseViewportStability;
    this.#releaseViewportStability = undefined;
    release?.();
  }

  public retainViewportStability(release: (() => void) | undefined): void {
    this.#releaseViewportStability = release;
  }

  readonly #tick = (time: number): void => {
    this.#frame = undefined;
    if (this.#options.container.isConnected === false) {
      this.cancel();
      return;
    }
    const progress = Math.min(1, Math.max(0, (time - this.#startTime) / LOCK_LAYOUT_DURATION_MS));
    this.#apply(progress);
    if (progress < 1) this.#scheduleFrame();
    else this.#settle();
  };

  #apply(progress: number): void {
    const eased = progress * progress * (3 - 2 * progress);
    const targetView = {
      cameraX: interpolate(this.#options.oldViewState.cameraX, 0, eased),
      zoom: interpolate(this.#options.oldViewState.zoom, this.#target.fitZoom, eased),
    };
    const blockSize = interpolate(
      this.#target.oldBlockSize,
      this.#target.lockedHeight * this.#target.fitZoom + this.#target.verticalInsets,
      eased,
    );
    const anchored = resolveAnchoredLayout(
      this.#options,
      targetView,
      this.#target.lockedHeight,
      blockSize,
      this.#target.width,
      this.#target.oldBlockSize,
    );
    this.#options.container.style.blockSize = `${String(blockSize)}px`;
    applyResolvedLayout(this.#options, targetView, anchored);
  }

  #scheduleFrame(): void {
    this.#frame = this.#ownerWindow.requestAnimationFrame(this.#tick);
  }

  #cancelFrame(): void {
    if (this.#frame !== undefined) this.#ownerWindow.cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
  }

  #settle(): void {
    this.#settled = true;
    if (activeTransitions.get(this.#options.container) === this) {
      activeTransitions.delete(this.#options.container);
    }
  }
}

function minimumLockRangeReserve(
  anchor: SceneLayoutAnchor | undefined,
  target: LockTarget,
): number {
  if (anchor === undefined || Math.abs(anchor.oldScrollTop - anchor.scrollBounds.max) > 0.5) {
    return 0;
  }
  const targetBlockSize = target.lockedHeight * target.fitZoom + target.verticalInsets;
  return Math.max(0, target.oldBlockSize - targetBlockSize);
}

function resolveAnchoredLayout(
  options: Pick<LockedFitLayoutOptions, "anchor" | "oldViewState">,
  target: ActiveEditorViewState,
  pageHeight: number,
  targetBlockSize: number,
  contentWidth: number,
  oldBlockSize: number,
): SceneLayoutUpdate | undefined {
  const anchor = options.anchor;
  if (anchor === undefined) return undefined;
  const width = Math.max(1, contentWidth);
  const fitZoom = width / PAGE_WIDTH;
  const anchored = applyAnchoredZoom({
    anchor: { anchorViewportY: anchor.anchorViewportY, anchorX: anchor.viewportWidth / 2 },
    containerWidth: width,
    derivedPageHeight: pageHeight,
    embedTopInScrollContent: anchor.embedTopInScrollContent,
    oldCameraX: options.oldViewState.cameraX,
    oldScrollTop: anchor.oldScrollTop,
    oldZoom: options.oldViewState.zoom,
    requestedZoom: target.zoom,
    scrollBounds: {
      min: anchor.scrollBounds.min,
      max: Math.max(
        anchor.scrollBounds.min,
        anchor.scrollBounds.max + targetBlockSize - oldBlockSize,
      ),
    },
    zoomLimits: calculateZoomLimits(fitZoom),
  });
  return {
    cameraX: anchored.camera.x,
    fitZoom,
    zoom: anchored.camera.zoom,
  };
}

function applyResolvedLayout(
  options: Pick<LockedFitLayoutOptions, "applyResize" | "restoreViewState">,
  target: ActiveEditorViewState,
  update: SceneLayoutUpdate | undefined,
): void {
  if (update === undefined || !options.applyResize(update)) options.restoreViewState(target);
}

function interpolate(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

export { LOCK_PRESENTATION_DURATION_MS };
