import type { MotionPreference } from "../../rendering/motion/transitions";
import { animateOwnedElement } from "../runtime/element-motion";
import { observeEffectiveMotion, type ObserveMotion } from "../runtime/effective-motion";

/** One native compositor animation belongs to the visible, active import operation. */
export class ImageImportSpinner {
  #animation: ReturnType<typeof animateOwnedElement> | undefined;
  #active = false;
  #reduced = true;
  #disposed = false;
  readonly #releaseMotion: () => void;
  readonly #visibilityChanged = (): void => this.#sync();

  public constructor(
    private readonly icon: HTMLElement,
    options: {
      readonly readMotion: () => MotionPreference;
      readonly observeMotion?: ObserveMotion;
    },
  ) {
    this.#releaseMotion = observeEffectiveMotion(
      icon,
      options.readMotion,
      (reduced) => {
        this.#reduced = reduced;
        this.#sync();
      },
      options.observeMotion,
    );
    icon.ownerDocument.addEventListener("visibilitychange", this.#visibilityChanged);
  }

  public setActive(active: boolean): void {
    this.#active = active;
    this.#sync();
  }

  #sync(): void {
    const animate =
      this.#active && !this.#reduced && !this.#disposed && !this.icon.ownerDocument.hidden;
    if (!animate) {
      this.#animation?.cancel();
      this.#animation = undefined;
      this.icon.style.removeProperty("rotate");
    } else if (this.#animation === undefined && typeof this.icon.animate === "function") {
      this.#animation = animateOwnedElement(
        this.icon,
        { rotate: ["0deg", "360deg"] },
        {
          duration: 0.8,
          ease: "linear",
          repeat: Infinity,
        },
      );
      void this.#animation.finished.catch(() => undefined);
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#sync();
    this.#releaseMotion();
    this.icon.ownerDocument.removeEventListener("visibilitychange", this.#visibilityChanged);
  }
}
