import type { NativeControlFeedbackOptions } from "../menus/feedback/native-control-feedback";
import { createSettingsValidationMotion } from "./settings-validation-motion";

export const SETTINGS_SAVE_FAILURE_MESSAGE = "The setting could not be saved.";

interface SettingsWriteHandlers {
  readonly error: (message: string) => void;
  readonly failureMessage?: string;
  readonly restore: () => void;
  readonly saved?: () => void;
}

/** Keeps completed writes from changing newer drafts or disposed controls. */
export class SettingsWriteFeedback {
  readonly #latest = new Map<string, number>();
  #disposed = false;

  public invalidate(key: string): number {
    const sequence = (this.#latest.get(key) ?? 0) + 1;
    this.#latest.set(key, sequence);
    return sequence;
  }

  public async run(
    key: string,
    write: (isCurrent: () => boolean) => void | string | Promise<void | string>,
    handlers: SettingsWriteHandlers,
  ): Promise<void> {
    if (this.#disposed) return;
    const sequence = this.invalidate(key);
    const isCurrent = (): boolean => !this.#disposed && this.#latest.get(key) === sequence;
    handlers.error("");
    try {
      const message = await write(isCurrent);
      if (!isCurrent()) return;
      if (typeof message === "string" && message !== "") handlers.error(message);
      else handlers.saved?.();
    } catch {
      if (!isCurrent()) return;
      handlers.restore();
      handlers.error(handlers.failureMessage ?? SETTINGS_SAVE_FAILURE_MESSAGE);
    }
  }

  public dispose(): void {
    this.#disposed = true;
    this.#latest.clear();
  }
}

let settingsErrorSequence = 0;

/** Reuses the existing validation owner without allocating a Motion root on success. */
export function createSettingsWriteError(row: HTMLElement, options: NativeControlFeedbackOptions) {
  let error: HTMLElement | undefined;
  let validation: ReturnType<typeof createSettingsValidationMotion> | undefined;
  const controls = new Set<HTMLElement>();
  const previousDescriptions = new Map<HTMLElement, string | null>();
  return {
    associate: (control: HTMLElement): void => {
      controls.add(
        control.tagName === "LABEL" ? ((control as HTMLLabelElement).control ?? control) : control,
      );
    },
    set: (message: string): void => {
      if (message === "" && error === undefined) return;
      if (error === undefined) {
        error = row.createDiv({ cls: "inkbook-settings-control-error" });
        error.id = `inkbook-setting-write-error-${String(++settingsErrorSequence)}`;
        error.hidden = true;
        error.setAttribute("aria-live", "polite");
        for (const control of controls) {
          const previous = control.getAttribute("aria-describedby");
          previousDescriptions.set(control, previous);
          control.setAttribute("aria-describedby", [previous, error.id].filter(Boolean).join(" "));
        }
        validation = createSettingsValidationMotion(row, options);
      }
      validation?.set(error, message);
    },
    dispose: (): void => {
      validation?.dispose();
      for (const [control, previous] of previousDescriptions) {
        if (previous === null) control.removeAttribute("aria-describedby");
        else control.setAttribute("aria-describedby", previous);
      }
      error?.remove();
      controls.clear();
      previousDescriptions.clear();
    },
  };
}
