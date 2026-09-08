import type { InkbookDeviceSettingsV2 } from "../../domain/settings";

const PANEL_TRANSITION_TIMEOUT_MS = 300;

export class SettingsPanelMotion {
  readonly #ownerWindow: Window | null;
  readonly #panel: HTMLElement;
  readonly #readMotion: () => InkbookDeviceSettingsV2["motion"];
  #cancelTransition: (() => void) | undefined;

  public constructor(panel: HTMLElement, readMotion: () => InkbookDeviceSettingsV2["motion"]) {
    this.#ownerWindow = panel.ownerDocument.defaultView;
    this.#panel = panel;
    this.#readMotion = readMotion;
  }

  public setExpanded(expanded: boolean): void {
    if (this.#reducedMotion()) {
      this.#cancelTransition?.();
      this.#panel.inert = !expanded;
      this.#applyFinalState(expanded);
      return;
    }

    const currentHeight = this.#panel.hidden ? 0 : this.#panel.getBoundingClientRect().height;
    this.#cancelTransition?.();
    this.#panel.inert = !expanded;
    this.#panel.hidden = false;
    const targetHeight = expanded ? this.#panel.getBoundingClientRect().height : 0;
    this.#startTransition(currentHeight, targetHeight, expanded);
  }

  public dispose(): void {
    this.#cancelTransition?.();
  }

  #applyFinalState(expanded: boolean): void {
    this.#panel.hidden = !expanded;
    delete this.#panel.dataset.resizing;
    this.#panel.style.removeProperty("block-size");
  }

  #reducedMotion(): boolean {
    const motion = this.#readMotion();
    if (motion !== "system") return motion === "reduced";
    return this.#ownerWindow?.matchMedia("(prefers-reduced-motion: reduce)").matches ?? true;
  }

  #startTransition(start: number, target: number, expanded: boolean): void {
    const ownerWindow = this.#ownerWindow;
    if (ownerWindow === null || Math.abs(target - start) < 0.5) {
      this.#applyFinalState(expanded);
      return;
    }

    const panel = this.#panel;
    panel.dataset.resizing = "true";
    panel.style.blockSize = `${String(start)}px`;
    void panel.offsetHeight;
    let frame: number | undefined = ownerWindow.requestAnimationFrame(() => {
      frame = undefined;
      panel.style.blockSize = `${String(target)}px`;
      this.#listenForCompletion(ownerWindow, expanded);
    });
    this.#cancelTransition = (): void => {
      if (frame !== undefined) ownerWindow.cancelAnimationFrame(frame);
      frame = undefined;
      this.#cancelTransition = undefined;
      delete panel.dataset.resizing;
      panel.style.removeProperty("block-size");
    };
  }

  #listenForCompletion(ownerWindow: Window, expanded: boolean): void {
    let timeout: number | undefined;
    const cancel = (): void => {
      this.#panel.removeEventListener("transitionend", onTransitionEnd);
      this.#panel.removeEventListener("transitioncancel", finish);
      if (timeout !== undefined) ownerWindow.clearTimeout(timeout);
      this.#cancelTransition = undefined;
      delete this.#panel.dataset.resizing;
      this.#panel.style.removeProperty("block-size");
    };
    const finish = (): void => {
      cancel();
      this.#applyFinalState(expanded);
    };
    const onTransitionEnd = (event: TransitionEvent): void => {
      if (
        event.target === this.#panel &&
        (event.propertyName === "block-size" || event.propertyName === "height")
      )
        finish();
    };
    this.#cancelTransition = cancel;
    this.#panel.addEventListener("transitionend", onTransitionEnd);
    this.#panel.addEventListener("transitioncancel", finish);
    timeout = ownerWindow.setTimeout(finish, PANEL_TRANSITION_TIMEOUT_MS);
  }
}
