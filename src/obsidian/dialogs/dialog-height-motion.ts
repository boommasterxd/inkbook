import {
  getTransitionDuration,
  isReducedMotion,
  STANDARD_EASING,
  type MotionPreference,
} from "../../rendering/motion/transitions";
import { observeEffectiveMotion, type ObserveMotion } from "../runtime/effective-motion";
import { animateOwnedElement } from "../runtime/element-motion";

/** Retargets an owned dialog's intrinsic height around complete synchronous mutations. */
export class DialogHeightMotion {
  readonly #surface: HTMLElement;
  readonly #readMotion: () => MotionPreference;
  readonly #height: string;
  readonly #heightPriority: string;
  readonly #releasePreference: () => void;
  #animation: ReturnType<typeof animateOwnedElement> | undefined;
  #depth = 0;
  #disposed = false;
  #frozen = false;

  public constructor(
    surface: HTMLElement,
    readMotion: () => MotionPreference,
    observeMotion?: ObserveMotion,
  ) {
    this.#surface = surface;
    this.#readMotion = readMotion;
    this.#height = surface.style.getPropertyValue("height");
    this.#heightPriority = surface.style.getPropertyPriority("height");
    this.#releasePreference = observeEffectiveMotion(
      surface,
      readMotion,
      (reduced) => {
        if (reduced && !this.#disposed) this.#settle();
      },
      observeMotion,
    );
  }

  public mutate(update: () => void): void {
    if (this.#disposed) return;
    if (this.#depth > 0 || this.#frozen) {
      update();
      return;
    }
    const ownerWindow = this.#surface.ownerDocument.defaultView;
    const animate =
      this.#surface.isConnected &&
      ownerWindow !== null &&
      ownerWindow.CSS?.supports("interpolate-size", "allow-keywords") === true &&
      this.#duration() > 0;
    const current = animate ? ownerWindow.getComputedStyle(this.#surface).height : undefined;
    this.#stop();
    this.#depth += 1;
    try {
      update();
    } finally {
      this.#depth -= 1;
      if (current !== undefined && !this.#disposed && !this.#frozen && this.#duration() > 0)
        this.#animate(current);
      else if (!this.#disposed && !this.#frozen) this.#restoreHeight();
    }
  }

  /** Keep the visible shell stable while its owner performs exit and content teardown. */
  public freeze(): void {
    if (this.#disposed || this.#frozen) return;
    const ownerWindow = this.#surface.ownerDocument.defaultView;
    const current =
      this.#surface.isConnected && ownerWindow !== null
        ? ownerWindow.getComputedStyle(this.#surface).height
        : undefined;
    this.#frozen = true;
    this.#stop();
    if (current !== undefined) this.#surface.style.height = current;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#releasePreference();
    this.#settle();
  }

  #animate(current: string): void {
    const animation = animateOwnedElement(
      this.#surface,
      { height: [current, "auto"] },
      {
        duration: this.#duration() / 1000,
        ease: STANDARD_EASING,
        onComplete: () => {
          if (this.#animation !== animation) return;
          this.#animation = undefined;
          this.#restoreHeight();
        },
      },
    );
    this.#animation = animation;
  }

  #duration(): number {
    const systemReduced =
      this.#surface.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)")
        .matches ?? false;
    return getTransitionDuration(
      "adaptiveMenu",
      isReducedMotion(this.#readMotion(), systemReduced),
    );
  }

  #settle(): void {
    this.#stop();
    this.#restoreHeight();
  }

  #stop(): void {
    const animation = this.#animation;
    this.#animation = undefined;
    animation?.stop();
  }

  #restoreHeight(): void {
    if (this.#height === "") this.#surface.style.removeProperty("height");
    else this.#surface.style.setProperty("height", this.#height, this.#heightPriority);
  }
}
