import { effectiveTransitionDuration } from "../../runtime/effective-motion";
import { observeMenuMotionPreference, playMenuMotion } from "../../menus/feedback/menu-motion";

/** Retains only inert guide pixels during exit; all input ownership ends immediately. */
export class OnboardingPresence {
  readonly #surface: HTMLElement;
  readonly #root: HTMLElement;
  #cancel: (() => void) | undefined;
  #unobserve: (() => void) | undefined;
  #onExited: (() => void) | undefined;

  public constructor(surface: HTMLElement, root: HTMLElement) {
    this.#surface = surface;
    this.#root = root;
    const ownerWindow = root.ownerDocument.defaultView;
    if (ownerWindow !== null)
      this.#unobserve = observeMenuMotionPreference(root, ownerWindow, () => this.#finish());
    this.#cancel = playMenuMotion(surface, { opacity: [0, 1] }, this.#duration());
  }

  public close(onExited: () => void): void {
    this.#onExited = onExited;
    this.#surface.inert = true;
    this.#surface.setAttribute("aria-hidden", "true");
    const opacity = this.#root.ownerDocument.defaultView?.getComputedStyle(this.#surface).opacity;
    this.#cancel?.();
    this.#cancel = playMenuMotion(
      this.#surface,
      { opacity: [opacity || "1", 0] },
      this.#duration(),
      () => this.#finish(),
    );
  }

  public dispose(): void {
    this.#cancel?.();
    this.#cancel = undefined;
    this.#onExited = undefined;
    this.#unobserve?.();
    this.#unobserve = undefined;
    this.#surface.remove();
  }

  #finish(): void {
    const onExited = this.#onExited;
    if (onExited === undefined) {
      this.#cancel?.();
      this.#cancel = undefined;
      playMenuMotion(this.#surface, { opacity: [1] }, 0);
      return;
    }
    this.dispose();
    onExited();
  }

  #duration(): number {
    const ownerWindow = this.#root.ownerDocument.defaultView;
    return ownerWindow === null
      ? 0
      : effectiveTransitionDuration(this.#root, ownerWindow, "adaptiveMenu");
  }
}
