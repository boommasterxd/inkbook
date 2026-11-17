import type { ImageResourceV3 } from "../../domain/schema/public";
import { imageImportResolution } from "../../domain/images/image-import-resolution";
import { IMAGE_LIMITS } from "../../domain/images/image-limits";
import { BoundedVersionLru } from "../../domain/cache/bounded-version-lru";
import { setIcon } from "obsidian";
import { ImageImportStaging } from "./image-import-staging";
import { ImageImportSpinner } from "./image-import-spinner";
import { ImageImportPages } from "./image-import-pages";
import { ImageImportReviewLayout } from "./image-import-review-layout";
import { imageImportErrorMessage } from "./image-import-error";
import { ImageDialog, type ImageImportDialogOptions } from "./image-dialog";
import { ImagePlacementPreview } from "./image-placement-preview";
import { prepareRasterImage, readImageSource, type PreparedRasterImage } from "./image-import";
import {
  openPdfImageSource,
  type PdfImageSource,
  type PdfImageResolution,
} from "./pdf-image-source";
import {
  ImageImportResolutionControl,
  imageResolutionDescription,
} from "./image-import-resolution-control";

interface PreparedImportImage extends PreparedRasterImage {
  readonly resolution?: PdfImageResolution | undefined;
}

export function openImageImportDialog(options: ImageImportDialogOptions): Promise<void> {
  if (options.signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => new ImageImportDialog(options, resolve).open());
}

class ImageImportDialog extends ImageDialog<void, ImageImportDialogOptions> {
  readonly #prepared = new BoundedVersionLru<PreparedImportImage>(
    IMAGE_LIMITS.pdfSelectedPages,
    IMAGE_LIMITS.documentPixels * 4,
  );
  #pdf: PdfImageSource | undefined;
  #preview: ImageResourceV3 | undefined;
  #previewPage = 1;
  #previewQuality = "high";
  #rasterBytes: Uint8Array<ArrayBuffer> | undefined;
  #busy = false;
  #refreshing = false;
  #generation = 0;
  #input!: HTMLInputElement;
  #choose!: HTMLButtonElement;
  #body!: HTMLElement;
  #fileName!: HTMLElement;
  #fileHint!: HTMLElement;
  #fileIcon!: HTMLElement;
  #spinner: ImageImportSpinner | undefined;
  #replace!: HTMLElement;
  #review!: ImageImportReviewLayout;
  #previewHint!: HTMLElement;
  #sourceDescription = "";
  #insert!: HTMLButtonElement;
  #placementPreview!: ImagePlacementPreview;
  #status!: HTMLElement;
  #error!: HTMLElement;
  #resizeWarning!: HTMLElement;
  #resizeWarningText!: HTMLElement;
  #details!: HTMLElement;
  #pdfPages!: ImageImportPages;
  #quality!: HTMLSelectElement;
  #resolution!: ImageImportResolutionControl;
  #placement!: HTMLElement;
  #pageWidth!: HTMLInputElement;

  protected build(): void {
    const { t } = this.options.localization;
    this.setTitle(t("images.import"));
    this.modalEl.classList.add("inkbook-image-import-surface");
    this.contentEl.classList.add("inkbook-image-import-content");
    this.#body = this.contentEl.createDiv({ cls: "inkbook-image-import-body" });
    this.#buildSource();
    this.#error = this.#body.createEl("p", {
      cls: "inkbook-image-import-error inkbook-settings-control-error",
    });
    this.#error.setAttribute("role", "alert");
    this.#review = new ImageImportReviewLayout(this.#body, this.modalEl);
    this.#placementPreview = new ImagePlacementPreview(this.#review.figure, this.options);
    const { details, hint } = this.#review.addCaption(this.options.localization);
    this.#details = details;
    this.#previewHint = hint;
    this.#buildPdfFields();
    this.#buildResolution();
    const { field, input } = this.#review.addPlacement(this.options.localization);
    this.#placement = field;
    this.#pageWidth = input;
    this.listen(input, "change", () => this.#placementPreview.setPlacement(input.checked));
    const warning = this.#review.addResizeWarning();
    this.#resizeWarning = warning.element;
    this.#resizeWarningText = warning.text;
    this.#status = this.contentEl.createEl("p", { cls: "inkbook-menu-visually-hidden" });
    this.#status.setAttribute("role", "status");
    this.#status.setAttribute("aria-live", "polite");
    const footer = this.contentEl.createDiv({ cls: "inkbook-image-import-footer" });
    const actions = footer.createDiv({ cls: "inkbook-dialog-actions" });
    this.action(actions, t("images.cancel"), () => this.close());
    this.#insert = this.action(actions, t("images.insert"), () => {
      void this.#commit();
    });
    this.#insert.classList.add("mod-cta");
    this.#insert.disabled = true;
  }

  #buildSource(): void {
    const { t } = this.options.localization;
    this.#input = this.contentEl.createEl("input", { type: "file" });
    this.#input.accept =
      ".png,.jpg,.jpeg,.webp,.pdf,image/png,image/jpeg,image/webp,application/pdf";
    this.#input.hidden = true;
    this.#input.setAttribute("aria-label", t("images.choose"));
    this.listen(this.#input, "change", () => {
      const file = this.#input.files?.[0];
      this.#input.value = "";
      if (file !== undefined) void this.#select(file);
    });
    this.#choose = this.action(this.#body, "", () => {
      if (!this.#refreshing) this.#input.click();
    });
    this.#choose.classList.add("inkbook-image-import-source");
    this.#choose.setAttribute("aria-label", t("images.choose"));
    this.#fileIcon = this.#choose.createSpan({
      cls: "inkbook-image-import-source-icon",
      attr: { "aria-hidden": "true" },
    });
    setIcon(this.#fileIcon, "image-plus");
    this.#spinner = new ImageImportSpinner(this.#fileIcon, this.options);
    const copy = this.#choose.createSpan({ cls: "inkbook-image-import-source-copy" });
    this.#fileName = copy.createSpan({
      cls: "inkbook-image-import-source-name",
      text: t("images.choose"),
    });
    this.#fileHint = copy.createSpan({
      cls: "inkbook-image-import-source-hint",
      text: t("images.formats"),
    });
    this.#fileHint.id = `inkbook-image-source-${crypto.randomUUID()}`;
    this.#choose.setAttribute("aria-describedby", this.#fileHint.id);
    this.#sourceDescription = t("images.formats");
    this.#replace = this.#choose.createSpan({
      cls: "inkbook-image-import-replace",
      text: t("images.change"),
    });
    this.#replace.hidden = true;
  }

  #buildPdfFields(): void {
    this.#pdfPages = new ImageImportPages(this.#review.controls, this.#review.previews, {
      localization: this.options.localization,
      scheduler: this.options.scheduler,
      readMotion: this.options.readMotion,
      displayedRaster: (page) =>
        page === this.#previewPage && this.#preview !== undefined
          ? this.#placementPreview.raster
          : undefined,
      ...(this.options.observeMotion ? { observeMotion: this.options.observeMotion } : {}),
      signal: this.abort.signal,
      mutate: (update) => update(),
      changed: (page) => {
        this.#updateInsert();
        if (page !== undefined) void this.#refreshPreview();
      },
    });
    this.#review.figure.insertBefore(this.#pdfPages.navigation, this.#details.parentElement);
  }

  #buildResolution(): void {
    this.#resolution = new ImageImportResolutionControl(
      this.#review.controls,
      this.options.localization,
    );
    this.#quality = this.#resolution.select;
    this.listen(this.#quality, "change", () => {
      void this.#refreshPreview();
    });
  }

  async #select(file: File): Promise<void> {
    if (this.#busy || this.#refreshing || this.abort.signal.aborted) return;
    this.#setBusy(true);
    this.#prepared.clear();
    this.#preview = undefined;
    this.#rasterBytes = undefined;
    this.#pdfPages.setSource(undefined);
    this.#placementPreview.clear();
    this.#review.setReview(undefined);
    this.#placement.hidden = true;
    this.#resolution.element.hidden = true;
    this.#resizeWarning.hidden = true;
    this.#resizeWarningText.textContent = "";
    this.#sourceDescription = this.options.localization.t("images.formats");
    this.#fileName.textContent = file.name;
    this.#fileName.title = file.name;
    this.#choose.setAttribute(
      "aria-label",
      `${file.name} · ${this.options.localization.t("images.change")}`,
    );
    const generation = ++this.#generation;
    try {
      await this.#pdf?.dispose();
      this.#pdf = undefined;
      const bytes = await readImageSource(file, this.abort.signal);
      if (String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-") {
        this.#pdf = await openPdfImageSource(bytes, this.abort.signal);
        this.#pdfPages.setSource(this.#pdf.pageCount);
        this.#pdfPages.setThumbnailSource(this.#pdf);
      } else this.#rasterBytes = bytes;
      this.#previewPage = 1;
      this.#previewQuality = this.#quality.value;
      const prepared = await this.#prepare(1);
      if (this.abort.signal.aborted) return;
      this.#showPreview(prepared);
    } catch (error) {
      this.#showError(error);
    } finally {
      if (generation === this.#generation) this.#setBusy(false);
    }
  }

  #rasterOptions() {
    const profile = imageImportResolution(this.#quality.value);
    return {
      document: this.contentEl.ownerDocument,
      scheduler: this.options.scheduler,
      signal: this.abort.signal,
      scale: profile.dpi / 72,
      maximumPixels: profile.maximumPixels,
    };
  }

  async #prepare(page: number): Promise<PreparedImportImage> {
    this.abort.signal.throwIfAborted();
    const key = `${this.#quality.value}:${page}`;
    const retained = this.#prepared.get(key, this.#generation);
    if (retained !== undefined) return retained;
    const pdf = this.#pdf;
    const options = this.#rasterOptions();
    const prepared: PreparedImportImage =
      pdf === undefined
        ? await prepareRasterImage(this.#rasterBytes!, options)
        : { resource: await pdf.render(page, options), resolution: pdf.resolution };
    this.abort.signal.throwIfAborted();
    const { resource } = prepared;
    const bytes = resource.width * resource.height * 4 + resource.data.length * 2 + 256;
    this.#prepared.set(key, this.#generation, prepared, bytes);
    return prepared;
  }

  async #refreshPreview(): Promise<void> {
    if (this.#busy || this.#refreshing || !this.#needsPreview()) return;
    this.#setRefreshing(true);
    try {
      // Keep one foreground render in flight and publish only the latest requested view.
      while (this.#needsPreview()) {
        const page = this.#pdfPages.page;
        const quality = this.#quality.value;
        try {
          const prepared = await this.#prepare(page);
          if (!this.#matchesPreviewRequest(page, quality)) continue;
          this.#previewPage = page;
          this.#previewQuality = quality;
          this.#showPreview(prepared);
        } catch (error) {
          if (!this.#matchesPreviewRequest(page, quality)) continue;
          this.#preview = undefined;
          this.#showError(error);
          break;
        }
      }
    } finally {
      this.#setRefreshing(false);
    }
  }

  #needsPreview(): boolean {
    return (
      !this.abort.signal.aborted &&
      (this.#pdf !== undefined || this.#rasterBytes !== undefined) &&
      this.#pdfPages.previewValid &&
      (this.#preview === undefined ||
        !this.#matchesPreviewRequest(this.#previewPage, this.#previewQuality))
    );
  }

  #matchesPreviewRequest(page: number, quality: string): boolean {
    return (
      !this.abort.signal.aborted &&
      this.#pdfPages.previewValid &&
      this.#pdfPages.page === page &&
      this.#quality.value === quality
    );
  }

  #setRefreshing(refreshing: boolean): void {
    if (this.abort.signal.aborted) return;
    this.#refreshing = refreshing;
    this.#pdfPages.setPreviewPreparing(refreshing);
    this.#review.figure.setAttribute("aria-busy", String(refreshing));
    if (refreshing) this.#choose.setAttribute("aria-disabled", "true");
    else this.#choose.removeAttribute("aria-disabled");
    if (refreshing) this.#error.textContent = "";
    this.#status.textContent = refreshing ? this.options.localization.t("images.preparing") : "";
    this.#updateInsert();
  }

  #showPreview({ resource, resizedFrom, resolution }: PreparedImportImage): void {
    if (this.abort.signal.aborted) return;
    this.#preview = resource;
    this.#review.setReview(
      this.#pdf === undefined
        ? "standard"
        : this.#pdf.pageCount === 1
          ? "single-page"
          : "pdf-pages",
    );
    this.#resolution.show(this.#pdf !== undefined);
    const { details, warning } = imageResolutionDescription(this.options.localization.t, resource, {
      resizedFrom,
      resolution,
    });
    this.#resizeWarning.hidden = warning === "";
    this.#resizeWarningText.textContent = warning;
    this.#details.textContent = details;
    this.#choose.dataset.selected = "true";
    this.#replace.hidden = false;
    this.#placementPreview.show(
      resource,
      this.#pdf === undefined ? "image" : "pdf",
      this.#pageWidth.checked,
    );
    this.#details.parentElement!.hidden = false;
    this.#review.figure.hidden = false;
    this.#placement.hidden = false;
    this.#previewHint.hidden = this.#pdf?.pageCount !== 1;
    this.#sourceDescription =
      this.#pdf === undefined
        ? resource.mimeType === "image/png"
          ? "PNG"
          : resource.mimeType === "image/webp"
            ? "WebP"
            : "JPEG"
        : this.options.localization.t(
            this.#pdf.pageCount === 1 ? "images.singlePage" : "images.pageCount",
            { count: this.#pdf.pageCount },
          );
    this.#fileHint.textContent = this.#sourceDescription;
  }

  async #commit(): Promise<void> {
    if (this.#busy || this.#refreshing || this.#preview === undefined || this.abort.signal.aborted)
      return;
    if (this.#pdf !== undefined && !this.#pdfPages.valid) return;
    const restoreFocus = this.#insert.ownerDocument.activeElement === this.#insert;
    this.#setBusy(true);
    try {
      const staging = new ImageImportStaging();
      if (this.#pdf === undefined) staging.add(this.#preview);
      else {
        const pages = this.#pdfPages.selection!;
        for (const [index, page] of pages.entries()) {
          this.abort.signal.throwIfAborted();
          this.#status.textContent = this.options.localization.t("images.preparingPage", {
            page,
            index: index + 1,
            total: pages.length,
          });
          this.#fileHint.textContent = this.#status.textContent;
          const resource =
            page === this.#previewPage && this.#quality.value === this.#previewQuality
              ? this.#preview
              : (await this.#prepare(page)).resource;
          this.abort.signal.throwIfAborted();
          staging.add(resource);
        }
      }
      this.abort.signal.throwIfAborted();
      const status = await this.options.submit(
        {
          resources: staging.resources,
          source: this.#pdf === undefined ? "image" : "pdf",
          ...(this.#pageWidth.checked ? { placement: "page-width-locked" } : {}),
        },
        this.abort.signal,
      );
      if (status === "committed") this.close();
      else if (!this.abort.signal.aborted)
        this.#error.textContent = this.options.localization.t(
          status === "capacity" ? "images.failureCapacity" : "images.failureUnavailable",
        );
    } catch (error) {
      this.#showError(error);
    } finally {
      this.#setBusy(false);
      if (
        restoreFocus &&
        !this.abort.signal.aborted &&
        this.#insert.ownerDocument.activeElement === this.#insert.ownerDocument.body
      )
        this.#insert.focus({ preventScroll: true });
    }
  }

  #showError(error: unknown): void {
    if (!this.abort.signal.aborted) {
      if (this.#preview === undefined) {
        this.#placementPreview.clear();
        this.#resizeWarning.hidden = true;
        this.#resizeWarningText.textContent = "";
        this.#review.figure.hidden = this.#pdf === undefined;
        this.#details.parentElement!.hidden = true;
        if (this.#pdf !== undefined || this.#rasterBytes !== undefined)
          this.#resolution.show(this.#pdf !== undefined);
        this.#placement.hidden = true;
        this.#choose.dataset.selected = "true";
        this.#replace.hidden = false;
      }
      this.#error.textContent = this.options.localization.t(imageImportErrorMessage(error));
    }
  }

  #setBusy(busy: boolean): void {
    if (this.abort.signal.aborted) return;
    this.#busy = busy;
    this.#body.setAttribute("aria-busy", String(busy));
    this.#body.dataset.preparing = String(busy);
    this.#choose.dataset.busy = String(busy);
    this.#fileName.hidden = busy;
    this.#replace.hidden = busy || this.#choose.dataset.selected !== "true";
    setIcon(
      this.#fileIcon,
      busy
        ? "loader-circle"
        : this.#pdf !== undefined
          ? "file-text"
          : this.#preview !== undefined
            ? "file-image"
            : "image-plus",
    );
    this.#spinner?.setActive(busy);
    this.#choose.disabled = busy;
    this.#updateInsert();
    this.#pdfPages.setBusy(busy);
    for (const input of [this.#quality, this.#pageWidth]) input.disabled = busy;
    this.#status.textContent = busy ? this.options.localization.t("images.preparing") : "";
    this.#fileHint.textContent = busy ? this.#status.textContent : this.#sourceDescription;
    if (busy) this.#error.textContent = "";
  }

  #updateInsert(): void {
    const { t } = this.options.localization;
    const pages = this.#pdfPages.selection;
    this.#insert.textContent =
      this.#pdf === undefined
        ? t("images.insert")
        : pages === undefined
          ? t("images.insertSelectedPages")
          : t(pages.length === 1 ? "images.insertPage" : "images.insertPages", {
              count: pages.length,
            });
    this.#insert.disabled =
      this.#busy ||
      this.#refreshing ||
      this.#preview === undefined ||
      (this.#pdf !== undefined && !this.#pdfPages.valid);
  }

  protected override get phoneContentScroll(): HTMLElement {
    return this.#body;
  }

  protected override onClosing(): void {
    this.#prepared.clear();
    this.#spinner?.dispose();
    super.onClosing();
    void this.#pdf?.dispose().catch(() => undefined);
    this.#pdf = undefined;
  }

  public override onClose(): void {
    this.#prepared.clear();
    this.#spinner?.dispose();
    this.#spinner = undefined;
    this.#placementPreview?.dispose();
    void this.#pdf?.dispose().catch(() => undefined);
    this.#pdf = undefined;
    this.#rasterBytes = undefined;
    this.#preview = undefined;
    super.onClose();
  }
}
