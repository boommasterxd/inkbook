import type { App } from "obsidian";
import type { Localization } from "../../../domain/localization";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { bindElementLanguage } from "../../../rendering/localization/element-language";
import type { MotionPreference } from "../../../rendering/motion/transitions";
import { InkbookModal } from "../../dialogs/inkbook-modal";
import { DialogHeightMotion } from "../../dialogs/dialog-height-motion";
import { confirmInkbookAction } from "../../dialogs/action-dialog";
import type { VaultFontLibrary } from "../../fonts/vault-font-library";
import type { ObserveMotion } from "../../runtime/effective-motion";
import { mountFontLibraryContent } from "./font-library-settings";
import { friendlyFontVariant } from "./font-import-view";

export interface FontLibraryDialogOptions {
  readonly localization: Localization;
  readonly library: VaultFontLibrary;
  readonly workScheduler: (ownerWindow: Window | null) => WorkScheduler;
  readonly readMotion: () => MotionPreference;
  readonly observeMotion?: ObserveMotion;
  readonly signal: AbortSignal;
  readonly onChanged: () => void;
  readonly onClosed: () => void;
  readonly trigger: HTMLElement;
}

export interface FontLibraryDialogHandle {
  close(): void;
  closeImmediately(): void;
}

export function openFontLibraryDialog(
  app: App,
  options: FontLibraryDialogOptions,
): FontLibraryDialogHandle {
  const dialog = new FontLibraryDialog(app, options);
  dialog.open();
  return dialog;
}

class FontLibraryDialog extends InkbookModal {
  readonly #options: FontLibraryDialogOptions;
  #body: HTMLElement | undefined;
  #disposeContent: (() => void) | undefined;
  #releaseLanguage: (() => void) | undefined;
  #unsubscribeLanguage: (() => void) | undefined;
  #heightMotion: DialogHeightMotion | undefined;

  public constructor(app: App, options: FontLibraryDialogOptions) {
    super(app, options.readMotion, options.workScheduler, options.observeMotion);
    this.#options = options;
  }

  protected override get phoneContentScroll(): HTMLElement | undefined {
    return this.#body;
  }

  public override open(): void {
    super.open();
    if (!this.closed && !this.closing) {
      this.#heightMotion ??= new DialogHeightMotion(
        this.modalEl,
        this.#options.readMotion,
        this.#options.observeMotion,
      );
      this.#body?.querySelector<HTMLButtonElement>("button:not([disabled]):not([hidden])")?.focus();
    }
  }

  protected override onClosing(): void {
    this.#heightMotion?.freeze();
  }

  public override onOpen(): void {
    if (this.#options.signal.aborted) {
      this.closeImmediately();
      return;
    }
    super.onOpen();
    this.modalEl.classList.remove("inkbook-action-dialog");
    this.modalEl.classList.add("inkbook-settings-modal", "inkbook-font-library-dialog");
    this.containerEl.classList.add("inkbook-font-library-container");
    this.contentEl.classList.add("inkbook-font-library-dialog-content");
    this.titleEl.classList.add("inkbook-font-library-title");
    this.#body = this.contentEl.createDiv({ cls: "inkbook-font-library-body" });
    this.#releaseLanguage = bindElementLanguage(this.modalEl, this.#options.localization);
    this.#unsubscribeLanguage = this.#options.localization.subscribe(this.#render);
    this.#render();
    this.#options.signal.addEventListener("abort", this.#ownerClosed);
  }

  #render = (): void => {
    const body = this.#body;
    if (this.closed || body === undefined) return;
    this.#mutateLayout(() => {
      this.#disposeContent?.();
      const { localization } = this.#options;
      this.setTitle(localization.t("fonts.group"));
      this.#disposeContent = mountFontLibraryContent(body, {
        ...this.#options,
        scheduler: this.#options.workScheduler,
        changed: this.#options.onChanged,
        mutateDialogLayout: this.#mutateLayout,
        confirmRemove: (face, signal) =>
          confirmInkbookAction(this.app, {
            ...this.#options,
            signal,
            title: () =>
              localization.t("fonts.removeNamed", {
                name: `${face.displayName} · ${friendlyFontVariant(face, localization.t)}`,
              }),
            description: () => localization.t("fonts.retention"),
            confirmLabel: () => localization.t("fonts.remove"),
            destructive: true,
          }),
      });
    });
  };

  readonly #mutateLayout = (update: () => void): void => {
    if (this.#heightMotion === undefined || this.entering || this.closing) update();
    else this.#heightMotion.mutate(update);
  };

  #ownerClosed = (): void => this.closeImmediately();

  public override onClose(): void {
    if (this.closed) return;
    this.#options.signal.removeEventListener("abort", this.#ownerClosed);
    this.#heightMotion?.dispose();
    this.#heightMotion = undefined;
    this.#disposeContent?.();
    this.#disposeContent = undefined;
    this.#unsubscribeLanguage?.();
    this.#releaseLanguage?.();
    super.onClose();
    if (this.#options.trigger.isConnected) this.#options.trigger.focus();
    this.#options.onClosed();
  }
}
