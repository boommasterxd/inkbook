import type { App } from "obsidian";
import type { Localization } from "../../domain/localization";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import type { MotionPreference } from "../../rendering/motion/transitions";
import { InkbookModal } from "../dialogs/inkbook-modal";
import type { ObserveMotion } from "../runtime/effective-motion";
import { registerNativeControlFeedback } from "../menus/feedback/native-control-feedback";
import { bindElementLanguage } from "../../rendering/localization/element-language";
import type { ImageImportRequest } from "../embeds/active-scene/editor-chrome-openings";

export interface ImageDialogOptions {
  readonly app: App;
  readonly localization: Localization;
  readonly scheduler: WorkScheduler;
  readonly readMotion: () => MotionPreference;
  readonly observeMotion?: ObserveMotion;
  readonly signal?: AbortSignal;
}

export interface ImageImportDialogOptions extends ImageDialogOptions, ImageImportRequest {}

/** Shared host modal, focus, motion, language and owner-cancellation lifetime. */
export abstract class ImageDialog<
  T,
  Options extends ImageDialogOptions = ImageDialogOptions,
> extends InkbookModal {
  protected readonly abort = new AbortController();
  protected result: T | undefined;
  #releaseFeedback: (() => void) | undefined;
  #releaseLanguage: (() => void) | undefined;
  readonly #ownerAbort = (): void => this.closeImmediately();

  public constructor(
    protected readonly options: Options,
    private readonly resolve: (result: T | undefined) => void,
  ) {
    super(
      options.app,
      options.readMotion,
      () => options.scheduler,
      options.observeMotion,
      options.localization,
    );
  }

  public override onOpen(): void {
    super.onOpen();
    this.containerEl.classList.add("inkbook-image-dialog-container");
    this.modalEl.classList.add("inkbook-image-dialog-surface");
    this.contentEl.classList.add("inkbook-image-dialog");
    this.#releaseLanguage = bindElementLanguage(this.modalEl, this.options.localization);
    this.options.signal?.addEventListener("abort", this.#ownerAbort, { once: true });
    this.build();
    this.#releaseFeedback = registerNativeControlFeedback(this.contentEl, this.options);
    if (this.options.signal?.aborted === true) this.closeImmediately();
  }

  protected abstract build(): void;

  protected override get phoneContentScroll(): HTMLElement {
    return this.contentEl;
  }

  protected override onClosing(): void {
    this.abort.abort();
  }

  public override onClose(): void {
    if (this.closed) return;
    this.abort.abort();
    this.options.signal?.removeEventListener("abort", this.#ownerAbort);
    this.#releaseFeedback?.();
    this.#releaseLanguage?.();
    super.onClose();
    this.resolve(this.result);
  }

  protected action(container: HTMLElement, label: string, callback: () => void): HTMLButtonElement {
    const button = container.createEl("button", { text: label, type: "button" });
    button.type = "button";
    this.listen(button, "click", callback);
    return button;
  }
}
