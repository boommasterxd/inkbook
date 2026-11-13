import type { App } from "obsidian";
import type { InkbookSettingsStore } from "../storage";
import type { VaultFontLibrary } from "../../fonts/vault-font-library";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { openFontLibraryDialog } from "./font-library-dialog";

interface FontLibraryAccessOptions {
  readonly app: App;
  readonly settings: InkbookSettingsStore;
  readonly library: VaultFontLibrary;
  readonly signal: AbortSignal;
  readonly workScheduler: (ownerWindow: Window | null) => WorkScheduler;
  readonly onChanged: () => void;
}

/** One plugin-owned management dialog; refresh callers only after it releases their focus. */
export class FontLibraryAccess {
  #dialog: ReturnType<typeof openFontLibraryDialog> | undefined;

  public constructor(private readonly options: FontLibraryAccessOptions) {}

  public readonly open = (trigger: HTMLButtonElement): void => {
    if (this.options.signal.aborted || this.#dialog !== undefined) return;
    const { settings } = this.options;
    const label = trigger.getAttribute("aria-label");
    let changed = false;
    let closed = false;
    const dialog = openFontLibraryDialog(this.options.app, {
      localization: settings.localization,
      library: this.options.library,
      workScheduler: this.options.workScheduler,
      readMotion: () => settings.getDeviceSettings().motion,
      observeMotion: (listener) => settings.subscribeDeviceSettings(listener),
      signal: this.options.signal,
      trigger,
      onChanged: () => {
        changed = true;
        if (closed && !this.options.signal.aborted) this.options.onChanged();
      },
      onClosed: () => {
        closed = true;
        if (this.#dialog !== dialog) return;
        this.#dialog = undefined;
        if (!changed || this.options.signal.aborted) return;
        this.options.onChanged();
        const replacement = [
          ...trigger.ownerDocument.querySelectorAll<HTMLButtonElement>('[role="combobox"]'),
        ].find((button) => button.getAttribute("aria-label") === label);
        if (!trigger.isConnected) replacement?.focus({ preventScroll: true });
      },
    });
    this.#dialog = dialog;
  };

  public dispose(): void {
    const dialog = this.#dialog;
    this.#dialog = undefined;
    dialog?.closeImmediately();
  }
}
