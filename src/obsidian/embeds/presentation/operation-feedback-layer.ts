import { STANDARD_EASING } from "../../../rendering/motion/transitions";
import { effectiveTransitionDuration } from "../../runtime/effective-motion";
import { animateOwnedElement } from "../../runtime/element-motion";

/** Owns one decorative feedback layer through interruption and teardown. */
export class OperationFeedbackLayer {
  #element: HTMLElement | undefined;
  #motion: ReturnType<typeof animateOwnedElement> | undefined;
  #exiting = false;
  #onHidden: (() => void) | undefined;

  public constructor(private readonly root: HTMLElement) {}

  public show(): void {
    if (this.#element !== undefined && !this.#exiting) return;
    this.dispose();
    this.#element = this.root.createDiv({ cls: "inkbook-operation-backdrop" });
    this.#element.setAttribute("aria-hidden", "true");
    this.#animate(0, 1);
  }

  public hide(onHidden?: () => void): void {
    const element = this.#element;
    if (element === undefined || this.#exiting) {
      onHidden?.();
      return;
    }
    this.#onHidden = onHidden;
    const ownerWindow = this.root.ownerDocument.defaultView;
    const opacity = Number.parseFloat(ownerWindow?.getComputedStyle(element).opacity ?? "1");
    this.#exiting = true;
    this.#animate(Number.isFinite(opacity) ? opacity : 1, 0, () => this.dispose());
  }

  public syncMotion(): void {
    const element = this.#element;
    const ownerWindow = this.root.ownerDocument.defaultView;
    if (
      element === undefined ||
      ownerWindow === null ||
      effectiveTransitionDuration(element, ownerWindow, "conditionalToolbarControl") > 0
    )
      return;
    this.#motion?.cancel();
    this.#motion = undefined;
    if (this.#exiting) this.dispose();
    else element.setCssProps({ opacity: "1" });
  }

  public dispose(): void {
    this.#motion?.cancel();
    this.#motion = undefined;
    this.#element?.remove();
    this.#element = undefined;
    this.#exiting = false;
    const onHidden = this.#onHidden;
    this.#onHidden = undefined;
    onHidden?.();
  }

  #animate(from: number, to: number, onComplete?: () => void): void {
    const element = this.#element;
    const ownerWindow = this.root.ownerDocument.defaultView;
    if (element === undefined || ownerWindow === null) return;
    const duration = effectiveTransitionDuration(element, ownerWindow, "conditionalToolbarControl");
    this.#motion?.cancel();
    this.#motion = undefined;
    element.style.opacity = String(to);
    if (duration === 0 || typeof element.animate !== "function") {
      onComplete?.();
      return;
    }
    this.#motion = animateOwnedElement(
      element,
      { opacity: [from, to] },
      {
        duration: duration / 1000,
        ease: [...STANDARD_EASING],
        ...(onComplete === undefined ? {} : { onComplete }),
      },
    );
    void this.#motion.finished.catch(() => undefined);
  }
}
