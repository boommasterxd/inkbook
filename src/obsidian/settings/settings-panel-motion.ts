import type { InkbookDeviceSettingsV2 } from "../../domain/settings";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";

const PANEL_TRANSITION_TIMEOUT_MS = 300;

export class SettingsPanelMotion {
  readonly #ownerWindow: Window | null;
  readonly #panel: HTMLElement;
  readonly #readMotion: () => InkbookDeviceSettingsV2["motion"];
  readonly #workScheduler: WorkScheduler;
  #cancelTransition: (() => void) | undefined;

  public constructor(
    panel: HTMLElement,
    readMotion: () => InkbookDeviceSettingsV2["motion"],
    workScheduler: WorkScheduler,
  ) {
    this.#ownerWindow = panel.ownerDocument.defaultView;
    this.#panel = panel;
    this.#readMotion = readMotion;
    this.#workScheduler = workScheduler;
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
    let frame: number | undefined = this.#workScheduler.requestFrame(() => {
      frame = undefined;
      panel.style.blockSize = `${String(target)}px`;
      this.#listenForCompletion(ownerWindow, expanded);
    });
    this.#cancelTransition = (): void => {
      if (frame !== undefined) this.#workScheduler.cancelFrame(frame);
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
    // Ignore queued cancellation from a replaced transition; completion has a bounded fallback.
    this.#panel.addEventListener("transitionend", onTransitionEnd);
    timeout = ownerWindow.setTimeout(finish, PANEL_TRANSITION_TIMEOUT_MS);
  }
}
