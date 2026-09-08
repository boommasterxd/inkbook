import type { InkbookDeviceSettingsV2 } from "../../../domain/settings/types";

export type ActiveEditorMotionPreference = InkbookDeviceSettingsV2["motion"];

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Resolves the device preference against the owning window and observes system changes. */
export class ActiveEditorMotion {
  readonly #mediaQuery: MediaQueryList | undefined;
  readonly #onReduced: () => void;
  #preference: ActiveEditorMotionPreference;

  public constructor(
    ownerWindow: Window,
    preference: ActiveEditorMotionPreference,
    onReduced: () => void,
  ) {
    this.#preference = preference;
    this.#onReduced = onReduced;
    this.#mediaQuery = ownerWindow.matchMedia?.(REDUCED_MOTION_QUERY);
    this.#mediaQuery?.addEventListener("change", this.#handleSystemChange);
  }

  public get reduced(): boolean {
    return (
      this.#preference === "reduced" ||
      (this.#preference === "system" && this.#mediaQuery?.matches === true)
    );
  }

  public dispose(): void {
    this.#mediaQuery?.removeEventListener("change", this.#handleSystemChange);
  }

  public update(preference: ActiveEditorMotionPreference): void {
    const wasReduced = this.reduced;
    this.#preference = preference;
    if (!wasReduced && this.reduced) this.#onReduced();
  }

  readonly #handleSystemChange = (): void => {
    if (this.#preference === "system" && this.#mediaQuery?.matches === true) {
      this.#onReduced();
    }
  };
}
