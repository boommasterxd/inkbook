import { isReducedMotion, type MotionPreference } from "../../rendering/motion/transitions";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import type { PresentationRemovalRange, PresentationRemovalSpacing } from "./presentation-port";
import { ActiveHeightTransition } from "./active-editor/height-transition";
import { LAYOUT_TRANSITION_CLASS } from "./transition-scroll-stability";

const EXIT_CLASS = "inkbook-presentation-exiting";
const HEIGHT_PROPERTY = "--inkbook-presentation-block-size";

/** Keeps the owned presentation mounted while its natural-size content is clipped away. */
export class PresentationExit {
  readonly #root: HTMLElement;
  readonly #motion: () => MotionPreference;
  readonly #query: MediaQueryList | undefined;
  readonly #transition: ActiveHeightTransition;
  #resolve: ((completed: boolean) => void) | undefined;
  #disposed = false;
  #inert = false;
  #height = 0;
  #spacing: PresentationRemovalSpacing = { before: 0, after: 0 };
  readonly #measureSpacing:
    ((range: PresentationRemovalRange) => PresentationRemovalSpacing) | undefined;

  readonly #removeMarkdown:
    | ((range: PresentationRemovalRange, expectedSource: string, mutate: () => void) => boolean)
    | undefined;

  constructor(
    root: HTMLElement,
    ownerWindow: Window,
    workScheduler: WorkScheduler,
    motion: () => MotionPreference,
    measureSpacing?: (range: PresentationRemovalRange) => PresentationRemovalSpacing,
    removeMarkdown?: (
      range: PresentationRemovalRange,
      expectedSource: string,
      mutate: () => void,
    ) => boolean,
  ) {
    this.#removeMarkdown = removeMarkdown;
    this.#measureSpacing = measureSpacing;
    this.#root = root;
    this.#motion = motion;
    this.#query = ownerWindow.matchMedia?.("(prefers-reduced-motion: reduce)");
    this.#transition = new ActiveHeightTransition(root, workScheduler);
  }

  begin(range: PresentationRemovalRange = { from: 0, to: 0 }): Promise<boolean> {
    if (this.#disposed || this.#resolve !== undefined) return Promise.resolve(false);
    const height = this.#root.getBoundingClientRect().height;
    if (this.#reducedMotion() || !Number.isFinite(height) || height <= 0) {
      return Promise.resolve(true);
    }
    this.#height = height;
    this.#spacing = this.#measureSpacing?.(range) ?? { before: 0, after: 0 };
    this.#inert = this.#root.inert;
    this.#root.inert = true;
    this.#root.classList.add(EXIT_CLASS, LAYOUT_TRANSITION_CLASS);
    this.#applyHeight(height);
    this.#query?.addEventListener("change", this.#handleMotionChange);
    return new Promise((resolve) => {
      this.#resolve = resolve;
      this.#transition.begin({
        currentRenderedHeight: height,
        targetRenderedHeight: 0,
        applySurfaceTarget: () => undefined,
        sceneCommitPending: () => false,
        applyFrame: (nextHeight) => {
          this.#applyHeight(nextHeight);
          if (nextHeight > 0 && this.#reducedMotion()) this.#transition.finishImmediately();
        },
        onComplete: () => this.#complete(true),
      });
    });
  }

  removeMarkdown(
    range: PresentationRemovalRange,
    expectedSource: string,
    mutate: () => void,
  ): boolean | undefined {
    if (this.#disposed) return false;
    return this.#removeMarkdown?.(range, expectedSource, mutate);
  }

  reset(): void {
    if (!this.#root.classList.contains(EXIT_CLASS)) return;
    this.#transition.cancel();
    this.#complete(false);
    this.#root.inert = this.#inert;
    this.#root.classList.remove(EXIT_CLASS, LAYOUT_TRANSITION_CLASS);
    this.#root.style.removeProperty(HEIGHT_PROPERTY);
    this.#root.style.removeProperty("--inkbook-presentation-exit-before");
    this.#root.style.removeProperty("--inkbook-presentation-exit-after");
  }

  dispose(): void {
    this.#disposed = true;
    this.reset();
  }

  readonly #handleMotionChange = (): void => {
    if (this.#reducedMotion()) this.#transition.finishImmediately();
  };

  #applyHeight(height: number): void {
    this.#root.style.setProperty(HEIGHT_PROPERTY, `${String(height)}px`);
    for (const side of ["before", "after"] as const) {
      const spacing = this.#spacing[side];
      const bounded = Number.isFinite(spacing) ? Math.max(0, spacing) : 0;
      this.#root.style.setProperty(
        `--inkbook-presentation-exit-${side}`,
        `${String(-bounded * (1 - height / this.#height))}px`,
      );
    }
  }

  #reducedMotion(): boolean {
    return isReducedMotion(this.#motion(), this.#query?.matches === true);
  }

  #complete(completed: boolean): void {
    this.#query?.removeEventListener("change", this.#handleMotionChange);
    this.#resolve?.(completed);
    this.#resolve = undefined;
  }
}
