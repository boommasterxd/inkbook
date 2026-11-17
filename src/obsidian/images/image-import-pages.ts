import { setIcon } from "obsidian";
import { IMAGE_LIMITS } from "../../domain/images/image-limits";
import type { Localization } from "../../domain/localization";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import type { MotionPreference } from "../../rendering/motion/transitions";
import type { ObserveMotion } from "../runtime/effective-motion";
import { parsePdfPages } from "./image-import";
import { ImageImportThumbnails } from "./image-import-thumbnails";
import type { PdfImageSource } from "./pdf-image-source";

interface PdfPagesOptions {
  readonly localization: Localization;
  readonly signal: AbortSignal;
  readonly scheduler: WorkScheduler;
  readonly readMotion: () => MotionPreference;
  readonly observeMotion?: ObserveMotion | undefined;
  readonly displayedRaster: (page: number) => HTMLImageElement | undefined;
  readonly changed: (previewPage?: number) => void;
  readonly mutate: (update: () => void) => void;
}

/** Keeps explicit import selection separate from freely browsable, validated previews. */
export class ImageImportPages {
  public readonly element: HTMLFieldSetElement;
  public readonly navigation: HTMLElement;
  readonly #range: HTMLInputElement;
  readonly #page: HTMLInputElement;
  readonly #rangeError: HTMLElement;
  readonly #pageError: HTMLElement;
  readonly #previous: HTMLButtonElement;
  readonly #next: HTMLButtonElement;
  readonly #total: HTMLElement;
  readonly #thumbnails: ImageImportThumbnails;
  #pageCount: number | undefined;
  #selection: readonly number[] | undefined = [1];
  #selectionKey = "1";
  #previewPage = 1;
  #validPage = true;
  #busy = false;

  public constructor(
    parent: HTMLElement,
    preview: HTMLElement,
    private readonly options: PdfPagesOptions,
  ) {
    const { t } = options.localization;
    this.#thumbnails = new ImageImportThumbnails(preview, {
      ...options,
      select: (page, selected) => this.#togglePage(page, selected),
    });
    this.element = parent.createEl("fieldset", { cls: "inkbook-image-import-pdf" });
    this.element.createEl("legend", {
      cls: "inkbook-menu-visually-hidden",
      text: t("images.pages"),
    });
    const label = this.element.createEl("label", { cls: "inkbook-image-field" });
    label.createSpan({ text: t("images.pages") });
    this.#range = label.createEl("input", { type: "text" });
    this.#range.maxLength = 256;
    this.#range.placeholder = "1, 3-5";
    this.#rangeError = this.#error(this.element, this.#range);
    this.element.createEl("p", {
      cls: "inkbook-image-import-pages-hint",
      text: t("images.pagesHint"),
    });
    this.navigation = preview.createDiv({ cls: "inkbook-image-import-preview-navigation" });
    const row = this.navigation.createDiv({ cls: "inkbook-image-import-page-controls" });
    this.#previous = this.#button(row, "chevron-left", t("images.previousPage"), -1);
    const pageLabel = row.createEl("label");
    pageLabel.createSpan({ text: t("images.pageLabel") });
    this.#page = pageLabel.createEl("input", { type: "number" });
    this.#page.min = "1";
    this.#page.setAttribute("aria-label", t("images.previewPage"));
    this.#total = pageLabel.createSpan();
    this.#next = this.#button(row, "chevron-right", t("images.nextPage"), 1);
    this.#pageError = this.#error(this.navigation, this.#page);
    this.#listen(this.#range, "input", () => this.#readSelection(false));
    this.#listen(this.#range, "change", () => this.#changeSelection());
    this.#listen(this.#page, "input", () => this.#readPage(false));
    this.#listen(this.#page, "change", () => this.#changePage());
    this.setSource(undefined);
  }

  public get selection(): readonly number[] | undefined {
    return this.#selection;
  }
  public get page(): number {
    return this.#previewPage;
  }
  public get valid(): boolean {
    return this.#selection !== undefined && this.#validPage;
  }
  public get previewValid(): boolean {
    return this.#validPage;
  }
  public setSource(pageCount: number | undefined): void {
    this.#thumbnails.setSource(undefined);
    this.#pageCount = pageCount;
    const lastPage = Math.min(pageCount ?? 1, IMAGE_LIMITS.pdfSelectedPages);
    this.#range.value = lastPage === 1 ? "1" : `1-${lastPage}`;
    this.#selection = parsePdfPages(this.#range.value, pageCount ?? 1);
    this.#selectionKey = this.#selection.join(",");
    this.#page.value = "1";
    this.#page.max = String(pageCount ?? 1);
    this.#previewPage = 1;
    this.#validPage = true;
    this.element.hidden = pageCount === undefined || pageCount === 1;
    this.navigation.hidden = this.element.hidden;
    this.#total.textContent = this.options.localization.t("images.pageTotal", {
      count: pageCount ?? 1,
    });
    this.#showError(this.#range, this.#rangeError, "");
    this.#showError(this.#page, this.#pageError, "");
    this.#updateNavigation();
  }

  public setThumbnailSource(source: PdfImageSource): void {
    this.#thumbnails.setSource(source);
  }

  public setPreviewPreparing(preparing: boolean): void {
    this.#thumbnails.setPreviewPreparing(preparing);
  }

  public setBusy(busy: boolean): void {
    this.#busy = busy;
    this.#range.disabled = busy;
    this.#page.disabled = busy;
    this.#updateNavigation();
  }

  #readSelection(report: boolean): boolean {
    try {
      this.#selection = parsePdfPages(this.#range.value, this.#pageCount ?? 1);
      this.#showError(this.#range, this.#rangeError, "");
    } catch {
      this.#selection = undefined;
      if (report)
        this.#showError(
          this.#range,
          this.#rangeError,
          this.options.localization.t("images.failurePages"),
        );
    }
    this.#updateNavigation();
    this.options.changed();
    return this.#selection !== undefined;
  }

  #changeSelection(): void {
    if (!this.#readSelection(true)) return;
    const key = this.#selection!.join(",");
    if (key === this.#selectionKey) return;
    this.#selectionKey = key;
    this.#page.value = String(this.#selection![0]);
    this.#changePage();
  }

  #readPage(report: boolean): boolean {
    const page = Number(this.#page.value);
    this.#validPage = Number.isInteger(page) && page >= 1 && page <= (this.#pageCount ?? 1);
    if (this.#validPage || report)
      this.#showError(
        this.#page,
        this.#pageError,
        this.#validPage
          ? ""
          : this.options.localization.t("images.failurePreviewPage", {
              count: this.#pageCount ?? 1,
            }),
      );
    this.options.changed();
    return this.#validPage;
  }

  #changePage(): void {
    if (!this.#readPage(true)) return;
    this.#previewPage = Number(this.#page.value);
    this.options.changed(this.#previewPage);
    this.#updateNavigation();
  }

  #goToPage(page: number): void {
    this.#page.value = String(page);
    this.#changePage();
  }

  #togglePage(page: number, selected: boolean): void {
    const current = this.#selection;
    if (current === undefined) return;
    const next = selected
      ? [...current, page].sort((left, right) => left - right)
      : current.filter((number) => number !== page);
    if (next.length === 0 || next.length > IMAGE_LIMITS.pdfSelectedPages) return;
    this.#selection = next;
    this.#selectionKey = next.join(",");
    this.#range.value = next.join(", ");
    this.#updateNavigation();
    this.options.changed();
  }

  #updateNavigation(): void {
    const active = this.navigation.ownerDocument.activeElement;
    this.#previous.disabled = this.#busy || this.#previewPage <= 1;
    this.#next.disabled = this.#busy || this.#previewPage >= (this.#pageCount ?? 1);
    if (this.#previous.disabled && !this.#next.disabled && active === this.#previous)
      this.#next.focus({ preventScroll: true });
    if (this.#next.disabled && !this.#previous.disabled && active === this.#next)
      this.#previous.focus({ preventScroll: true });
    this.#thumbnails.update(this.#previewPage, this.#selection, this.#busy);
  }

  #button(parent: HTMLElement, icon: string, label: string, step: number): HTMLButtonElement {
    const button = parent.createEl("button", {
      cls: "clickable-icon inkbook-image-import-page-action",
      type: "button",
    });
    button.setAttribute("aria-label", label);
    button.title = label;
    setIcon(button, icon);
    button.querySelector("svg")?.setAttribute("aria-hidden", "true");
    this.#listen(button, "click", () => this.#goToPage(this.#previewPage + step));
    return button;
  }

  #error(parent: HTMLElement, field: HTMLInputElement): HTMLElement {
    const error = parent.createEl("p", {
      cls: "inkbook-settings-control-error inkbook-image-import-field-error",
    });
    error.id = `inkbook-pdf-error-${crypto.randomUUID()}`;
    error.setAttribute("role", "alert");
    error.hidden = true;
    field.setAttribute("aria-describedby", error.id);
    return error;
  }

  #showError(field: HTMLInputElement, error: HTMLElement, text: string): void {
    if (error.textContent === text) return;
    this.options.mutate(() => {
      error.textContent = text;
      error.hidden = text === "";
      if (text === "") field.removeAttribute("aria-invalid");
      else field.setAttribute("aria-invalid", "true");
    });
  }

  #listen(target: HTMLElement, type: string, callback: () => void): void {
    target.addEventListener(
      type,
      () => {
        if (!this.#busy) callback();
      },
      { signal: this.options.signal },
    );
  }
}
