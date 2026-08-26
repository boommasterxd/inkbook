import { reduceInput, type InputState } from "../../../editor/input/index";
import type { ActiveEditorControllerOptions } from "./controller-types";

export function createActiveEditorTouchMode(
  options: ActiveEditorControllerOptions,
): ActiveEditorTouchMode {
  return new ActiveEditorTouchMode(
    options.renderer.inputSurface,
    options.deviceSettings.fingerDrawingEnabled,
  );
}

export class ActiveEditorTouchMode {
  #available: boolean;
  #enabled = false;
  readonly #surface: HTMLElement;

  public constructor(surface: HTMLElement, available: boolean) {
    this.#available = available;
    this.#surface = surface;
    this.#syncTouchAction();
  }

  public get available(): boolean {
    return this.#available;
  }

  public get enabled(): boolean {
    return this.#enabled;
  }

  public toggle(input: InputState): InputState {
    this.#enabled = !this.#enabled;
    this.#syncTouchAction();
    return reduceInput(input, {
      type: "configure",
      toolbarFingerDrawingEnabled: this.#enabled,
    }).state;
  }

  public updateAvailable(available: boolean): boolean {
    if (available === this.#available) return false;
    this.#available = available;
    this.#syncTouchAction();
    return true;
  }

  #syncTouchAction(): void {
    this.#surface.style.touchAction = this.#available && this.#enabled ? "none" : "pan-y";
  }
}
