/** Distinguishes observed keyboard modifiers from Chromium's synthetic pinch Ctrl flag. */
export class WheelZoomModifiers {
  #control = false;
  #meta = false;
  readonly #keyDown = (event: KeyboardEvent): void => {
    if (event.key === "Control") this.#control = true;
    else if (!event.ctrlKey) this.#control = false;
    if (event.key === "Meta") this.#meta = true;
    else if (!event.metaKey) this.#meta = false;
  };
  readonly #keyUp = (event: KeyboardEvent): void => {
    if (!event.ctrlKey) this.#control = false;
    if (!event.metaKey) this.#meta = false;
  };
  readonly #reset = (): void => {
    this.#control = false;
    this.#meta = false;
  };

  public constructor(readonly ownerWindow: Window) {
    ownerWindow.addEventListener("keydown", this.#keyDown, true);
    ownerWindow.addEventListener("keyup", this.#keyUp, true);
    ownerWindow.addEventListener("blur", this.#reset);
  }

  public matches(event: Pick<WheelEvent, "ctrlKey" | "metaKey">): boolean {
    // An absent flag also repairs missed releases before another wheel gesture.
    if (!event.ctrlKey) this.#control = false;
    if (!event.metaKey) this.#meta = false;
    return this.#control || this.#meta;
  }

  public dispose(): void {
    this.ownerWindow.removeEventListener("keydown", this.#keyDown, true);
    this.ownerWindow.removeEventListener("keyup", this.#keyUp, true);
    this.ownerWindow.removeEventListener("blur", this.#reset);
    this.#reset();
  }
}
