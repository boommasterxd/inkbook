import { isReducedMotion, type MotionPreference } from "../../rendering/motion/transitions";
import { ActiveHeightTransition } from "./active-editor/height-transition";
import { LAYOUT_TRANSITION_CLASS } from "./transition-scroll-stability";

const LOADING_PLACEHOLDER_HEIGHT = 48;
const HEIGHT_PROPERTY = "--inkbook-loading-block-size";

interface LoadingPlaceholderMotionOptions {
  readonly initialHeight?: number;
  readonly motion: MotionPreference;
  readonly onHeight?: (height: number) => void;
}

/** Owns the bounded reveal before a validated preview replaces the placeholder. */
export class LoadingPlaceholderMotion {
  readonly #element: HTMLElement;
  readonly #options: LoadingPlaceholderMotionOptions;
  readonly #query: MediaQueryList | undefined;
  readonly #transition: ActiveHeightTransition;
  #finished = false;
  #height = 0;

  constructor(element: HTMLElement, options: LoadingPlaceholderMotionOptions) {
    this.#element = element;
    this.#options = options;
    const ownerWindow = element.ownerDocument.defaultView;
    if (ownerWindow === null) throw new Error("Loading motion requires an owning window.");
    this.#query = ownerWindow.matchMedia?.("(prefers-reduced-motion: reduce)");
    this.#transition = new ActiveHeightTransition(element, ownerWindow);
    const initial = options.initialHeight ?? 0;
    this.#applyHeight(
      this.#reducedMotion()
        ? LOADING_PLACEHOLDER_HEIGHT
        : Number.isFinite(initial)
          ? Math.min(LOADING_PLACEHOLDER_HEIGHT, Math.max(0, initial))
          : 0,
    );
    if (this.#height === LOADING_PLACEHOLDER_HEIGHT) {
      this.#finished = true;
      return;
    }
    element.classList.add(LAYOUT_TRANSITION_CLASS);
    this.#query?.addEventListener("change", this.#handleMotionChange);
    this.#transition.begin({
      currentRenderedHeight: this.#height,
      targetRenderedHeight: LOADING_PLACEHOLDER_HEIGHT,
      applySurfaceTarget: () => undefined,
      sceneCommitPending: () => false,
      applyFrame: (height) => this.#applyHeight(height),
      onComplete: () => this.dispose(),
      stabilizeScroll: false,
    });
  }

  get renderedHeight(): number {
    return this.#height;
  }

  dispose(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#transition.cancel();
    this.#query?.removeEventListener("change", this.#handleMotionChange);
    this.#element.classList.remove(LAYOUT_TRANSITION_CLASS);
  }

  readonly #handleMotionChange = (): void => {
    if (this.#finished || !this.#reducedMotion()) return;
    this.#applyHeight(LOADING_PLACEHOLDER_HEIGHT);
    this.dispose();
  };

  #applyHeight(height: number): void {
    this.#height = height;
    this.#element.style.setProperty(HEIGHT_PROPERTY, `${String(height)}px`);
    this.#options.onHeight?.(height);
  }

  #reducedMotion(): boolean {
    return isReducedMotion(this.#options.motion, this.#query?.matches === true);
  }
}
