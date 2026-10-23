import { cubicBezier, keyframes } from "motion";
import { TRANSITION_DURATIONS } from "../../../../rendering/motion/transitions";
import type { WorkScheduler } from "../../../../domain/scheduling/work-scheduler";

const TRANSITION_CLASS = "inkbook-page-height-transitioning";
const ENVELOPE_PROPERTY = "--inkbook-page-height-envelope-block-size";
const heightEase = cubicBezier(1 / 3, 0, 2 / 3, 1);
const heightEaseOut = cubicBezier(0, 0, 0.58, 1);

interface ActiveHeightTransitionRequest {
  readonly applyFrame: (renderedHeight: number) => void;
  readonly applySurfaceTarget: () => void;
  readonly currentRenderedHeight: number;
  readonly onComplete: () => void;
  readonly sceneCommitPending: () => boolean;
  readonly stabilizeScroll?: boolean;
  readonly targetRenderedHeight: number;
  readonly durationMs?: number;
  readonly easing?: "ease-out";
  readonly paintPrepared?: boolean;
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
  readonly #workScheduler: WorkScheduler;
  #phase: TransitionPhase | undefined;
  #request: ActiveHeightTransitionRequest | undefined;
  #renderedHeight = 0;
  #releaseScrollStability: (() => void) | undefined;
  #startedAt = 0;
  #surfaceTargetApplied = false;
  #heightFrames: ReturnType<typeof keyframes<number>> | undefined;

  public constructor(
    container: HTMLElement,
    workScheduler: WorkScheduler,
    beginScrollStability?: () => () => void,
  ) {
    this.#beginScrollStability = beginScrollStability;
    this.#container = container;
    this.#workScheduler = workScheduler;
  }

  public get active(): boolean {
    return this.#request !== undefined;
  }

  public begin(request: ActiveHeightTransitionRequest): void {
    this.cancel();
    this.#releaseScrollStability =
      request.stabilizeScroll !== false ? this.#beginScrollStability?.() : undefined;
    this.#request = request;
    this.#renderedHeight = request.currentRenderedHeight;
    this.#heightFrames = keyframes({
      duration: request.durationMs ?? TRANSITION_DURATIONS.automaticPageGrowth,
      keyframes: [request.currentRenderedHeight, request.targetRenderedHeight],
      ease: request.easing === "ease-out" ? heightEaseOut : heightEase,
    });
    this.#phase = request.sceneCommitPending() ? "waiting-for-scene" : "waiting-for-paint";
    const envelope = Math.max(request.currentRenderedHeight, request.targetRenderedHeight);
    this.#container.classList.add(TRANSITION_CLASS);
    this.#container.style.setProperty(ENVELOPE_PROPERTY, `${String(envelope)}px`);
    if (request.targetRenderedHeight >= request.currentRenderedHeight) {
      request.applySurfaceTarget();
      this.#surfaceTargetApplied = true;
    }
    if (this.#phase === "waiting-for-paint") {
      if (request.paintPrepared) {
        this.#phase = "running";
        this.#startedAt = this.#workScheduler.now();
        this.#scheduleTick();
      } else this.#scheduleStartAfterPaint();
    }
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
    this.#frame = this.#workScheduler.requestFrame((time) => {
      this.#frame = undefined;
      if (this.#request === undefined || this.#phase !== "waiting-for-paint") return;
      this.#phase = "running";
      this.#startedAt = time;
      this.#scheduleTick();
    });
  }

  #scheduleTick(): void {
    this.#frame = this.#workScheduler.requestFrame(this.#tick);
  }

  readonly #tick = (time: number): void => {
    this.#frame = undefined;
    const request = this.#request;
    if (request === undefined || this.#phase !== "running") return;
    const frame = this.#heightFrames?.next(Math.max(0, time - this.#startedAt));
    if (frame !== undefined && !frame.done) {
      this.#renderedHeight = frame.value;
      request.applyFrame(this.#renderedHeight);
      if (this.#request === request) this.#scheduleTick();
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
    if (this.#frame !== undefined) this.#workScheduler.cancelFrame(this.#frame);
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
    this.#heightFrames = undefined;
    this.#container.classList.remove(TRANSITION_CLASS);
    this.#container.style.removeProperty(ENVELOPE_PROPERTY);
    releaseScrollStability?.();
  }
}
