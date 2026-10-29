import { animateOwnedElement } from "../../runtime/element-motion";
import { effectiveTransitionDuration } from "../../runtime/effective-motion";
import { STANDARD_EASING } from "../../../rendering/motion/transitions";
import { observeMenuMotionPreference } from "../../menus/feedback/menu-motion";
import { OnboardingBackground, type OnboardingBackgroundPort } from "./onboarding-background";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";

/** Presentation space only: the document, camera, and persisted page are untouched. */
export class OnboardingPageSpace {
  readonly #paper: HTMLElement | undefined;
  readonly #root: HTMLElement;
  readonly #original: string;
  readonly #background: OnboardingBackground;
  #minimum = 0;
  #animation: ReturnType<typeof animateOwnedElement> | undefined;
  #unobserve: (() => void) | undefined;

  public constructor(
    root: HTMLElement,
    scheduler: WorkScheduler,
    background?: OnboardingBackgroundPort,
  ) {
    this.#root = root;
    this.#paper = root.querySelector<HTMLElement>(".inkbook-background-container") ?? undefined;
    this.#original = this.#paper?.style.minBlockSize ?? "";
    this.#background = new OnboardingBackground(scheduler, background);
  }

  public setMinimum(minimum: number, immediate = false, onSettled?: () => void): void {
    const paper = this.#paper;
    if (paper === undefined) return;
    if (this.#minimum === minimum && !immediate && onSettled === undefined) return;
    this.#minimum = minimum;
    this.#animation?.stop();
    this.#background.prepare(minimum, () => this.#applyMinimum(minimum, immediate, onSettled));
  }

  #applyMinimum(minimum: number, immediate: boolean, onSettled?: () => void): void {
    const paper = this.#paper;
    if (paper === undefined) return;
    const ownerWindow = paper.ownerDocument.defaultView;
    if (minimum > 0 && this.#unobserve === undefined && ownerWindow !== null)
      this.#unobserve = observeMenuMotionPreference(this.#root, ownerWindow, () =>
        this.setMinimum(this.#minimum, true),
      );
    const duration =
      ownerWindow === null || immediate
        ? 0
        : effectiveTransitionDuration(this.#root, ownerWindow, "adaptiveMenu");
    const target = minimum === 0 ? this.#restingMinimum(paper) : `${String(minimum)}px`;
    if (duration === 0 || ownerWindow === null) {
      paper.style.minBlockSize = minimum === 0 ? this.#original : target;
      if (minimum === 0) this.#stopObserving();
      this.#background.settle(minimum);
      onSettled?.();
      return;
    }
    const style = ownerWindow.getComputedStyle(paper);
    const origin = style.blockSize || style.minBlockSize;
    this.#animation = animateOwnedElement(
      paper,
      {
        minBlockSize: [Number.isFinite(Number.parseFloat(origin)) ? origin : "0px", target],
      },
      {
        duration: duration / 1000,
        ease: [...STANDARD_EASING],
        onComplete: () => {
          if (this.#minimum === 0) {
            paper.style.minBlockSize = this.#original;
            this.#stopObserving();
          }
          this.#background.settle(this.#minimum);
          onSettled?.();
        },
      },
    );
    void this.#animation.finished.catch(() => undefined);
  }

  public dispose(): void {
    this.#animation?.stop();
    this.#background.dispose();
    this.#stopObserving();
    if (this.#paper !== undefined) this.#paper.style.minBlockSize = this.#original;
  }

  #stopObserving(): void {
    this.#unobserve?.();
    this.#unobserve = undefined;
  }

  #restingMinimum(paper: HTMLElement): string {
    const blockSize = Number.parseFloat(paper.style.blockSize);
    const minimum = Number.parseFloat(this.#original) || 0;
    return Number.isFinite(blockSize)
      ? `${String(Math.max(blockSize, minimum))}px`
      : this.#original || "0px";
  }
}
