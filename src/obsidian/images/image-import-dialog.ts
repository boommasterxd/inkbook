import type { ImageResourceV3 } from "../../domain/schema/public";
import type { ImageRasterSize } from "../../domain/images/image-raster-size";
import { imageImportResolution } from "../../domain/images/image-import-resolution";
import type { ImportedImageBatch } from "../embeds/active-scene/editor-chrome-openings";
import { setIcon } from "obsidian";
import { ImageImportStaging } from "./image-import-staging";
import { ImageImportSpinner } from "./image-import-spinner";
import { ImageImportPages } from "./image-import-pages";
import { imageImportErrorMessage } from "./image-import-error";
import { ImageDialog, type ImageDialogOptions } from "./image-dialog";
import { prepareRasterImage, readImageSource, type PreparedRasterImage } from "./image-import";
import { openPdfImageSource, type PdfImageSource } from "./pdf-image-source";
import {
  ImageImportResolutionControl,
  imageResolutionDescription,
} from "./image-import-resolution-control";

export function openImageImportDialog(
  options: ImageDialogOptions,
): Promise<ImportedImageBatch | undefined> {
  if (options.signal?.aborted === true) return Promise.resolve(undefined);
  return new Promise((resolve) => new ImageImportDialog(options, resolve).open());
}

class ImageImportDialog extends ImageDialog<ImportedImageBatch> {
  #pdf: PdfImageSource | undefined;
  #preview: ImageResourceV3 | undefined;
  #previewPage = 1;
  #previewQuality = "high";
  #rasterBytes: Uint8Array<ArrayBuffer> | undefined;
  #busy = false;
  #generation = 0;
  #input!: HTMLInputElement;
  #choose!: HTMLButtonElement;
  #body!: HTMLElement;
  #fileName!: HTMLElement;
  #fileHint!: HTMLElement;
  #fileIcon!: HTMLElement;
  #spinner: ImageImportSpinner | undefined;
  #replace!: HTMLElement;
  #figure!: HTMLElement;
  #previewHint!: HTMLElement;
  #sourceDescription = "";
  #insert!: HTMLButtonElement;
  #previewImage!: HTMLImageElement;
  #status!: HTMLElement;
  #error!: HTMLElement;
  #resizeWarning!: HTMLElement;
  #resizeWarningText!: HTMLElement;
  #details!: HTMLElement;
  #pdfPages!: ImageImportPages;
  #quality!: HTMLSelectElement;
  #resolution!: ImageImportResolutionControl;
  #placement!: HTMLLabelElement;
  #pageWidth!: HTMLInputElement;

  protected build(): void {
    const { t } = this.options.localization;
    this.setTitle(t("images.import"));
    this.modalEl.classList.add("inkbook-image-import-surface");
    this.titleEl.classList.add("inkbook-image-import-title");
    this.contentEl.classList.add("inkbook-image-import-content");
    this.#body = this.contentEl.createDiv({ cls: "inkbook-image-import-body" });
    this.#buildSource();
    this.#error = this.#body.createEl("p", {
      cls: "inkbook-image-import-error inkbook-settings-control-error",
    });
    this.#error.setAttribute("role", "alert");
    this.#resizeWarning = this.#body.createEl("p", {
      cls: "inkbook-image-import-resize-warning inkbook-settings-validation-visual",
    });
    this.#resizeWarning.setAttribute("role", "status");
    this.#resizeWarning.setAttribute("aria-live", "polite");
    this.#resizeWarning.hidden = true;
    const warningIcon = this.#resizeWarning.createSpan({
      cls: "inkbook-image-import-warning-icon",
      attr: { "aria-hidden": "true" },
    });
    setIcon(warningIcon, "triangle-alert");
    this.#resizeWarningText = this.#resizeWarning.createSpan();
    this.#buildPreview();
    this.#buildPdfFields();
    this.#buildResolution();
    this.#buildPlacement();
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
    this.#choose = this.action(this.#body, "", () => this.#input.click());
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

  #buildPreview(): void {
    const { t } = this.options.localization;
    this.#figure = this.#body.createEl("figure", { cls: "inkbook-image-import-figure" });
    this.#figure.hidden = true;
    const stage = this.#figure.createDiv({ cls: "inkbook-image-import-stage" });
    this.#previewImage = stage.createEl("img", { cls: "inkbook-image-import-preview" });
    this.#previewImage.alt = t("images.preview");
    const caption = this.#figure.createEl("figcaption");
    this.#details = caption.createSpan();
    this.#previewHint = caption.createSpan({ text: t("images.previewHint") });
    this.#previewHint.hidden = true;
  }

  #buildPlacement(): void {
    this.#placement = this.#body.createEl("label", {
      cls: "inkbook-menu-toggle-row inkbook-image-import-placement",
    });
    this.#placement.hidden = true;
    this.#placement.createSpan({ text: this.options.localization.t("images.pageWidthLocked") });
    const control = this.#placement.createSpan({ cls: "inkbook-menu-switch" });
    this.#pageWidth = control.createEl("input", { type: "checkbox" });
    control.createSpan({ cls: "inkbook-menu-switch-track" }).createSpan({
      cls: "inkbook-menu-switch-thumb",
    });
  }

  #buildPdfFields(): void {
    this.#pdfPages = new ImageImportPages(this.#body, this.#figure, {
      localization: this.options.localization,
      signal: this.abort.signal,
      mutate: (update) => update(),
      changed: (page) => {
        this.#updateInsert();
        if (page !== undefined) void this.#refreshPreview();
      },
    });
    this.#figure.insertBefore(this.#pdfPages.navigation, this.#details.parentElement);
  }

  #buildResolution(): void {
    this.#resolution = new ImageImportResolutionControl(this.#body, this.options.localization);
    this.#quality = this.#resolution.select;
    this.listen(this.#quality, "change", () => {
      void this.#refreshPreview();
    });
  }

  async #select(file: File): Promise<void> {
    if (this.#busy || this.abort.signal.aborted) return;
    this.#setBusy(true);
    this.#preview = undefined;
    this.#rasterBytes = undefined;
    this.#pdfPages.setSource(undefined);
    this.#previewImage.removeAttribute("src");
    delete this.modalEl.dataset.review;
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
        this.#previewPage = 1;
        this.#previewQuality = this.#quality.value;
        this.#showPreview(await this.#pdf.render(1, this.#rasterOptions()));
      } else {
        this.#rasterBytes = bytes;
        const prepared = await prepareRasterImage(bytes, this.#rasterOptions());
        this.#previewQuality = this.#quality.value;
        this.#showPreview(prepared.resource, prepared.resizedFrom);
      }
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

  async #refreshPreview(): Promise<void> {
    if (this.#busy || this.abort.signal.aborted) return;
    if (this.#pdf === undefined && this.#rasterBytes === undefined) return;
    if (this.#pdf !== undefined && !this.#pdfPages.previewValid) return;
    const page = this.#pdfPages.page;
    if (
      this.#preview !== undefined &&
      this.#quality.value === this.#previewQuality &&
      (this.#pdf === undefined || page === this.#previewPage)
    )
      return;
    const active = this.contentEl.ownerDocument.activeElement;
    const focused = active === this.#quality ? this.#quality : this.#pdfPages.focused;
    this.#setBusy(true, true);
    this.#preview = undefined;
    try {
      const prepared: PreparedRasterImage =
        this.#pdf !== undefined
          ? { resource: await this.#pdf.render(page, this.#rasterOptions()) }
          : await prepareRasterImage(this.#rasterBytes!, this.#rasterOptions());
      this.#previewPage = page;
      this.#previewQuality = this.#quality.value;
      this.#showPreview(prepared.resource, prepared.resizedFrom);
    } catch (error) {
      this.#showError(error);
    } finally {
      this.#setBusy(false);
      if (
        focused !== undefined &&
        focused.isConnected &&
        focused.ownerDocument.activeElement === focused.ownerDocument.body
      )
        (focused.disabled ? this.#pdfPages.navigationFocusTarget : focused).focus({
          preventScroll: true,
        });
    }
  }

  #showPreview(resource: ImageResourceV3, resizedFrom?: ImageRasterSize): void {
    if (this.abort.signal.aborted) return;
    this.#preview = resource;
    this.modalEl.dataset.review = "true";
    this.#resolution.show(this.#pdf !== undefined);
    const { details, warning } = imageResolutionDescription(this.options.localization.t, resource, {
      resizedFrom,
      resolution: this.#pdf?.resolution,
    });
    this.#resizeWarning.hidden = warning === "";
    this.#resizeWarningText.textContent = warning;
    this.#details.textContent = details;
    this.#choose.dataset.selected = "true";
    this.#replace.hidden = false;
    this.#previewImage.width = resource.width;
    this.#previewImage.height = resource.height;
    this.#previewImage.src = `data:${resource.mimeType};base64,${resource.data}`;
    this.#previewImage.parentElement!.hidden = false;
    this.#details.parentElement!.hidden = false;
    this.#figure.hidden = false;
    this.#placement.hidden = false;
    this.#previewHint.hidden = this.#pdf === undefined;
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
    if (this.#busy || this.#preview === undefined || this.abort.signal.aborted) return;
    if (this.#pdf !== undefined && !this.#pdfPages.valid) return;
    this.#setBusy(true);
    try {
      const staging = new ImageImportStaging();
      if (this.#pdf === undefined) staging.add(this.#preview);
      else {
        const pages = this.#pdfPages.selection!;
        for (const [index, page] of pages.entries()) {
          this.abort.signal.throwIfAborted();
          this.#status.textContent = this.options.localization.t("images.preparingPage", {
            page: index + 1,
            total: pages.length,
          });
          this.#fileHint.textContent = this.#status.textContent;
          const resource =
            page === this.#previewPage && this.#quality.value === this.#previewQuality
              ? this.#preview
              : await this.#pdf.render(page, this.#rasterOptions());
          this.abort.signal.throwIfAborted();
          staging.add(resource);
        }
      }
      this.abort.signal.throwIfAborted();
      this.result = {
        resources: staging.resources,
        source: this.#pdf === undefined ? "image" : "pdf",
        ...(this.#pageWidth.checked ? { placement: "page-width-locked" } : {}),
      };
      this.close();
    } catch (error) {
      this.#showError(error);
    } finally {
      this.#setBusy(false);
    }
  }

  #showError(error: unknown): void {
    if (!this.abort.signal.aborted) {
      if (this.#preview === undefined) {
        this.#previewImage.removeAttribute("src");
        this.#resizeWarning.hidden = true;
        this.#resizeWarningText.textContent = "";
        this.#figure.hidden = this.#pdf === undefined;
        this.#previewImage.parentElement!.hidden = true;
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

  #setBusy(busy: boolean, refreshing = false): void {
    if (this.abort.signal.aborted) return;
    this.#busy = busy;
    this.#renderBusy(busy, refreshing);
  }

  #renderBusy(busy: boolean, refreshing: boolean): void {
    const preparing = busy && !refreshing;
    this.#body.setAttribute("aria-busy", String(busy));
    this.#body.dataset.preparing = String(preparing);
    this.#choose.dataset.busy = String(preparing);
    this.#fileName.hidden = preparing;
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
    this.#fileHint.textContent = preparing
      ? this.options.localization.t("images.preparing")
      : this.#sourceDescription;
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
      this.#preview === undefined ||
      (this.#pdf !== undefined && !this.#pdfPages.valid);
  }

  protected override get phoneContentScroll(): HTMLElement {
    return this.#body;
  }

  protected override onClosing(): void {
    this.#spinner?.dispose();
    super.onClosing();
    void this.#pdf?.dispose().catch(() => undefined);
  }

  public override onClose(): void {
    this.#spinner?.dispose();
    this.#spinner = undefined;
    void this.#pdf?.dispose().catch(() => undefined);
    this.#pdf = undefined;
    this.#rasterBytes = undefined;
    this.#preview = undefined;
    super.onClose();
  }
}
