import { TRANSITION_DURATIONS } from "../../../rendering/motion/transitions";

const TRANSITION_CLASS = "inkbook-page-height-transitioning";
const ENVELOPE_PROPERTY = "--inkbook-page-height-envelope-block-size";

interface ActiveHeightTransitionRequest {
  readonly applyFrame: (renderedHeight: number) => void;
  readonly applySurfaceTarget: () => void;
  readonly currentRenderedHeight: number;
  readonly onComplete: () => void;
  readonly sceneCommitPending: () => boolean;
  readonly targetRenderedHeight: number;
}

export interface CancelledHeightTransition {
  readonly renderedHeight: number;
  readonly settleToTarget: boolean;
}

type TransitionPhase =
  "waiting-for-scene" | "waiting-for-paint" | "running" | "waiting-for-final-scene";

/**
 * Keeps the larger scene surface stable while the outer page height reveals or
 * clips it. The renderer and container therefore never expose different page
 * geometries in the same painted frame.
 */
export class ActiveHeightTransition {
  readonly #beginScrollStability: (() => () => void) | undefined;
  readonly #container: HTMLElement;
  #frame: number | undefined;
  #finishOnSceneCommit = false;
  readonly #ownerWindow: Window;
  #phase: TransitionPhase | undefined;
  #request: ActiveHeightTransitionRequest | undefined;
  #renderedHeight = 0;
  #releaseScrollStability: (() => void) | undefined;
  #startedAt = 0;
  #surfaceTargetApplied = false;

  public constructor(
    container: HTMLElement,
    ownerWindow: Window,
    beginScrollStability?: () => () => void,
  ) {
    this.#beginScrollStability = beginScrollStability;
    this.#container = container;
    this.#ownerWindow = ownerWindow;
  }

  public get active(): boolean {
    return this.#request !== undefined;
  }

  public begin(request: ActiveHeightTransitionRequest): void {
    this.cancel();
    this.#releaseScrollStability = this.#beginScrollStability?.();
    this.#request = request;
    this.#renderedHeight = request.currentRenderedHeight;
    this.#phase = request.sceneCommitPending() ? "waiting-for-scene" : "waiting-for-paint";
    const envelope = Math.max(request.currentRenderedHeight, request.targetRenderedHeight);
    this.#container.classList.add(TRANSITION_CLASS);
    this.#container.style.setProperty(ENVELOPE_PROPERTY, `${String(envelope)}px`);
    if (request.targetRenderedHeight >= request.currentRenderedHeight) {
      request.applySurfaceTarget();
      this.#surfaceTargetApplied = true;
    }
    if (this.#phase === "waiting-for-paint") this.#scheduleStartAfterPaint();
  }

  public sceneCommitted(): void {
    if (this.#phase === "waiting-for-final-scene") {
      this.#applyTargetFrameAndComplete();
      return;
    }
    if (this.#phase === "waiting-for-scene") {
      if (this.#finishOnSceneCommit) {
        this.#finishAfterSceneCommit();
        return;
      }
      this.#phase = "waiting-for-paint";
      this.#scheduleStartAfterPaint();
    }
  }

  public finishImmediately(): void {
    const request = this.#request;
    if (request === undefined) return;
    if (this.#phase === "waiting-for-scene" || this.#phase === "waiting-for-final-scene") {
      this.#finishOnSceneCommit = true;
      return;
    }
    this.#cancelFrame();
    this.#prepareFinalSurface();
  }

  public cancelAtCurrent(): CancelledHeightTransition | undefined {
    if (this.#request === undefined) return undefined;
    const renderedHeight = this.#renderedHeight;
    const settleToTarget = this.#phase === "running" || this.#phase === "waiting-for-final-scene";
    this.cancel();
    return { renderedHeight, settleToTarget };
  }

  public cancel(): void {
    this.#cancelFrame();
    this.#clear();
  }

  #scheduleStartAfterPaint(): void {
    this.#frame = this.#ownerWindow.requestAnimationFrame((time) => {
      this.#frame = undefined;
      if (this.#request === undefined || this.#phase !== "waiting-for-paint") return;
      this.#phase = "running";
      this.#startedAt = time;
      this.#scheduleTick();
    });
  }

  #scheduleTick(): void {
    this.#frame = this.#ownerWindow.requestAnimationFrame(this.#tick);
  }

  readonly #tick = (time: number): void => {
    this.#frame = undefined;
    const request = this.#request;
    if (request === undefined || this.#phase !== "running") return;
    const progress = Math.min(
      1,
      Math.max(0, (time - this.#startedAt) / TRANSITION_DURATIONS.automaticPageGrowth),
    );
    const eased = progress * progress * (3 - 2 * progress);
    if (progress < 1) {
      this.#renderedHeight = interpolate(
        request.currentRenderedHeight,
        request.targetRenderedHeight,
        eased,
      );
      request.applyFrame(this.#renderedHeight);
      this.#scheduleTick();
      return;
    }
    this.#prepareFinalSurface();
  };

  #complete(): void {
    const onComplete = this.#request?.onComplete;
    this.#clear();
    onComplete?.();
  }

  #finishAfterSceneCommit(): void {
    this.#prepareFinalSurface();
  }

  #prepareFinalSurface(): void {
    const request = this.#request;
    if (request === undefined) return;
    if (!this.#surfaceTargetApplied) {
      request.applySurfaceTarget();
      this.#surfaceTargetApplied = true;
    }
    if (request.sceneCommitPending()) {
      this.#phase = "waiting-for-final-scene";
      return;
    }
    this.#applyTargetFrameAndComplete();
  }

  #applyTargetFrameAndComplete(): void {
    const request = this.#request;
    if (request === undefined) return;
    this.#renderedHeight = request.targetRenderedHeight;
    request.applyFrame(this.#renderedHeight);
    this.#complete();
  }

  #cancelFrame(): void {
    if (this.#frame !== undefined) this.#ownerWindow.cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
  }

  #clear(): void {
    const releaseScrollStability = this.#releaseScrollStability;
    this.#releaseScrollStability = undefined;
    this.#request = undefined;
    this.#phase = undefined;
    this.#finishOnSceneCommit = false;
    this.#renderedHeight = 0;
    this.#startedAt = 0;
    this.#surfaceTargetApplied = false;
    this.#container.classList.remove(TRANSITION_CLASS);
    this.#container.style.removeProperty(ENVELOPE_PROPERTY);
    releaseScrollStability?.();
  }
}

function interpolate(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}
