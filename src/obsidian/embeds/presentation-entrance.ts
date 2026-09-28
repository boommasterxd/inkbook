import { isReducedMotion, type MotionPreference } from "../../rendering/motion/transitions";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { ActiveHeightTransition } from "./active-editor/height-transition";
import { LAYOUT_TRANSITION_CLASS } from "./transition-scroll-stability";

const ENTRANCE_CLASS = "inkbook-presentation-entering";
const HEIGHT_PROPERTY = "--inkbook-presentation-block-size";

export interface InitialPresentationEntrance {
  readonly activationReady: Promise<boolean>;
  readonly ready: Promise<boolean>;
  holdForActivation(): void;
  showLoading(): void;
  resumePreview(): void;
  revealActive(height: number): boolean;
}

export interface PresentationEntranceState {
  initialHeight?: number;
  loadingStartedAt?: number;
  presented: boolean;
}

interface PresentationEntranceOptions {
  readonly workScheduler: WorkScheduler;
  readonly motion: () => MotionPreference;
  readonly onPresented: () => void;
  readonly ownerWindow: Window;
  readonly preview: HTMLElement;
  readonly root: HTMLElement;
  readonly state?: PresentationEntranceState;
}

/** Reveals the natural-size preview once without resizing its SVG or replaying on refresh. */
export class PresentationEntrance {
  readonly ready: Promise<boolean>;
  readonly measured: Promise<boolean>;
  #resolveMeasured: ((measured: boolean) => void) | undefined;
  #held = false;
  #activeTarget = false;
  readonly #options: PresentationEntranceOptions;
  readonly #query: MediaQueryList | undefined;
  readonly #state: PresentationEntranceState;
  readonly #transition: ActiveHeightTransition;
  #resolve: ((presented: boolean) => void) | undefined;
  #finished = false;
  #height = 0;
  #target = 0;

  constructor(options: PresentationEntranceOptions) {
    this.#options = options;
    this.#state = options.state ?? { presented: false };
    this.#query = options.ownerWindow.matchMedia?.("(prefers-reduced-motion: reduce)");
    this.#transition = new ActiveHeightTransition(options.root, options.workScheduler);
    this.measured = new Promise((resolve) => {
      this.#resolveMeasured = resolve;
    });
    this.ready = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  get pending(): boolean {
    return !this.#finished;
  }

  prepare(): void {
    if (this.#finished) return;
    if (this.#state.presented || this.#reducedMotion()) {
      this.#finish(true);
      return;
    }
    this.#options.root.classList.add(ENTRANCE_CLASS, LAYOUT_TRANSITION_CLASS);
    const initialHeight = this.#state.initialHeight ?? 0;
    this.#applyHeight(Number.isFinite(initialHeight) && initialHeight > 0 ? initialHeight : 0);
    this.#query?.addEventListener("change", this.#handleMotionChange);
  }

  holdForActivation(): void {
    if (!this.#finished) {
      this.#held = true;
      this.#transition.cancel();
    }
  }

  showLoading(): void {
    if (this.#held && !this.#finished && this.#height < 48) this.#animateTo(48, false);
  }

  get activationReady(): Promise<boolean> {
    return this.#held ? this.measured : this.ready;
  }

  resumePreview(): void {
    if (!this.#held && !this.#activeTarget) return;
    this.#transition.cancel();
    this.#held = false;
    this.#activeTarget = false;
    this.#options.root.classList.remove("inkbook-presentation-activating");
    this.#target = 0;
    this.measure();
  }

  revealActive(height: number): boolean {
    if (!this.#held || this.#finished || !Number.isFinite(height) || height <= 0) return false;
    this.#held = false;
    this.#activeTarget = true;
    this.#options.root.classList.add("inkbook-presentation-activating");
    this.#animateTo(height);
    return true;
  }

  measure(): void {
    this.#resolveMeasured?.(true);
    this.#resolveMeasured = undefined;
    if (this.#finished || this.#held || this.#activeTarget) return;
    if (this.#reducedMotion()) {
      this.#finish(true);
      return;
    }
    const target = this.#options.preview.getBoundingClientRect().height;
    if (!Number.isFinite(target) || target <= 0 || Math.abs(target - this.#target) < 0.5) return;
    this.#animateTo(target);
  }

  #animateTo(target: number, complete = true): void {
    this.#target = target;
    if (this.#reducedMotion()) {
      if (complete) this.#finish(true);
      else this.#applyHeight(target);
      return;
    }
    this.#transition.begin({
      currentRenderedHeight: this.#height,
      targetRenderedHeight: target,
      applySurfaceTarget: () => undefined,
      sceneCommitPending: () => false,
      applyFrame: (height) => {
        if (this.#reducedMotion()) this.#finish(true);
        else this.#applyHeight(height);
      },
      onComplete: () => {
        if (complete) this.#finish(true);
      },
    });
  }

  dispose(): void {
    this.#finish(false);
  }

  readonly #handleMotionChange = (): void => {
    if (this.#reducedMotion()) this.#finish(true);
  };

  #applyHeight(height: number): void {
    this.#height = height;
    this.#state.initialHeight = height;
    this.#options.root.style.setProperty(HEIGHT_PROPERTY, `${String(height)}px`);
  }

  #reducedMotion(): boolean {
    return isReducedMotion(this.#options.motion(), this.#query?.matches === true);
  }

  #finish(presented: boolean): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#held = false;
    this.#activeTarget = false;
    if (!presented) {
      this.#resolveMeasured?.(false);
      this.#resolveMeasured = undefined;
    }
    this.#transition.cancel();
    this.#query?.removeEventListener("change", this.#handleMotionChange);
    this.#options.root.classList.remove(
      ENTRANCE_CLASS,
      LAYOUT_TRANSITION_CLASS,
      "inkbook-presentation-activating",
    );
    this.#options.root.style.removeProperty(HEIGHT_PROPERTY);
    if (presented) {
      this.#state.presented = true;
      this.#options.onPresented();
    }
    this.#resolve?.(presented);
    this.#resolve = undefined;
  }
}
