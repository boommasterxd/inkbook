import type { ImageResourceV3 } from "../../domain/schema/public";
import type { ImageRasterSize } from "../../domain/images/image-raster-size";
import type { ImportedImageBatch } from "../embeds/active-scene/editor-chrome-openings";
import { setIcon } from "obsidian";
import { DialogHeightMotion } from "../dialogs/dialog-height-motion";
import { ImageImportStaging } from "./image-import-staging";
import { ImageImportSpinner } from "./image-import-spinner";
import { imageImportErrorMessage } from "./image-import-error";
import { ImageDialog, type ImageDialogOptions } from "./image-dialog";
import { parsePdfPages, prepareRasterImage, readImageSource } from "./image-import";
import { openPdfImageSource, type PdfImageSource } from "./pdf-image-source";

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
  #previewScale = 2;
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
  #heightMotion: DialogHeightMotion | undefined;
  #insert!: HTMLButtonElement;
  #previewImage!: HTMLImageElement;
  #status!: HTMLElement;
  #error!: HTMLElement;
  #resizeWarning!: HTMLElement;
  #resizeWarningText!: HTMLElement;
  #details!: HTMLElement;
  #pdfFields!: HTMLElement;
  #pages!: HTMLInputElement;
  #page!: HTMLInputElement;
  #quality!: HTMLSelectElement;

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

  #buildPdfFields(): void {
    const { t } = this.options.localization;
    this.#pdfFields = this.#body.createEl("fieldset", { cls: "inkbook-image-import-pdf" });
    this.#pdfFields.hidden = true;
    this.#pdfFields.createEl("legend", {
      cls: "inkbook-menu-visually-hidden",
      text: t("images.pages"),
    });
    const label = this.#pdfFields.createEl("label", {
      cls: "inkbook-image-field inkbook-image-import-pages",
    });
    label.createSpan({ text: t("images.pages") });
    this.#pages = label.createEl("input", { type: "text" });
    this.#pages.maxLength = 256;
    this.#pages.value = "1";
    this.#pages.placeholder = "1, 3-5";
    this.#pdfFields.createEl("p", {
      cls: "inkbook-image-import-pages-hint",
      text: t("images.pagesHint"),
    });
    const pageLabel = this.#pdfFields.createEl("label", { cls: "inkbook-image-field" });
    pageLabel.createSpan({ text: t("images.previewPage") });
    this.#page = pageLabel.createEl("input", { type: "number" });
    this.#page.min = "1";
    this.#page.value = "1";
    const qualityLabel = this.#pdfFields.createEl("label", { cls: "inkbook-image-field" });
    qualityLabel.createSpan({ text: t("images.quality") });
    this.#quality = qualityLabel.createEl("select");
    this.#quality.createEl("option", { value: "1", text: t("images.standard") });
    this.#quality.createEl("option", { value: "2", text: t("images.high") });
    this.#quality.value = "2";
    this.listen(this.#page, "change", () => {
      void this.#refreshPdfPreview();
    });
    this.listen(this.#quality, "change", () => {
      void this.#refreshPdfPreview();
    });
  }

  async #select(file: File): Promise<void> {
    if (this.#busy || this.abort.signal.aborted) return;
    this.#setBusy(true);
    this.#preview = undefined;
    this.#mutateView(() => {
      this.#resizeWarning.hidden = true;
      this.#resizeWarningText.textContent = "";
      this.#sourceDescription = this.options.localization.t("images.formats");
      this.#fileName.textContent = file.name;
      this.#fileName.title = file.name;
      this.#choose.setAttribute(
        "aria-label",
        `${file.name} · ${this.options.localization.t("images.change")}`,
      );
    });
    const generation = ++this.#generation;
    try {
      await this.#pdf?.dispose();
      this.#pdf = undefined;
      const bytes = await readImageSource(file, this.abort.signal);
      if (String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-") {
        this.#pdf = await openPdfImageSource(bytes, this.abort.signal);
        this.#page.max = String(this.#pdf.pageCount);
        this.#page.value = "1";
        this.#pages.value = "1";
        this.#previewPage = 1;
        this.#previewScale = Number(this.#quality.value);
        this.#showPreview(await this.#pdf.render(1, this.#rasterOptions()));
      } else {
        const prepared = await prepareRasterImage(bytes, this.#rasterOptions());
        this.#showPreview(prepared.resource, prepared.resizedFrom);
      }
    } catch (error) {
      this.#showError(error);
    } finally {
      if (generation === this.#generation) this.#setBusy(false);
    }
  }

  #rasterOptions() {
    return {
      document: this.contentEl.ownerDocument,
      scheduler: this.options.scheduler,
      signal: this.abort.signal,
      scale: Number(this.#quality.value),
    };
  }

  async #refreshPdfPreview(): Promise<void> {
    if (this.#busy || this.#pdf === undefined || this.abort.signal.aborted) return;
    this.#setBusy(true);
    try {
      const page = Number(this.#page.value);
      const preview = await this.#pdf.render(page, this.#rasterOptions());
      this.#previewPage = page;
      this.#previewScale = Number(this.#quality.value);
      this.#showPreview(preview);
    } catch (error) {
      this.#showError(error);
    } finally {
      this.#setBusy(false);
    }
  }

  #showPreview(resource: ImageResourceV3, resizedFrom?: ImageRasterSize): void {
    if (this.abort.signal.aborted) return;
    this.#preview = resource;
    this.#mutateView(() => {
      this.#resizeWarning.hidden = resizedFrom === undefined;
      this.#resizeWarningText.textContent =
        resizedFrom === undefined
          ? ""
          : this.options.localization.t("images.resized", {
              sourceWidth: resizedFrom.width,
              sourceHeight: resizedFrom.height,
              width: resource.width,
              height: resource.height,
            });
      this.#choose.dataset.selected = "true";
      this.#replace.hidden = false;
      this.#previewImage.width = resource.width;
      this.#previewImage.height = resource.height;
      this.#previewImage.src = `data:${resource.mimeType};base64,${resource.data}`;
      this.#figure.hidden = false;
      this.#pdfFields.hidden = this.#pdf === undefined;
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
      this.#details.textContent = this.options.localization.t("images.details", {
        width: resource.width,
        height: resource.height,
      });
    });
  }

  async #commit(): Promise<void> {
    if (this.#busy || this.#preview === undefined || this.abort.signal.aborted) return;
    this.#setBusy(true);
    try {
      const staging = new ImageImportStaging();
      if (this.#pdf === undefined) staging.add(this.#preview);
      else {
        const pages = parsePdfPages(this.#pages.value, this.#pdf.pageCount);
        for (const [index, page] of pages.entries()) {
          this.abort.signal.throwIfAborted();
          this.#status.textContent = this.options.localization.t("images.preparingPage", {
            page: index + 1,
            total: pages.length,
          });
          this.#fileHint.textContent = this.#status.textContent;
          const resource =
            page === this.#previewPage && Number(this.#quality.value) === this.#previewScale
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
      };
      this.close();
    } catch (error) {
      this.#showError(error);
    } finally {
      this.#setBusy(false);
    }
  }

  #showError(error: unknown): void {
    if (!this.abort.signal.aborted)
      this.#mutateView(() => {
        if (this.#preview === undefined) {
          this.#figure.hidden = true;
          this.#pdfFields.hidden = true;
          this.#choose.dataset.selected = "true";
          this.#replace.hidden = false;
        }
        this.#error.textContent = this.options.localization.t(imageImportErrorMessage(error));
      });
  }

  #setBusy(busy: boolean): void {
    if (this.abort.signal.aborted) return;
    this.#busy = busy;
    this.#mutateView(() => this.#renderBusy(busy));
  }

  #renderBusy(busy: boolean): void {
    this.#body.setAttribute("aria-busy", String(busy));
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
    this.#insert.disabled = busy || this.#preview === undefined;
    for (const input of [this.#pages, this.#page, this.#quality]) input.disabled = busy;
    this.#status.textContent = busy ? this.options.localization.t("images.preparing") : "";
    this.#fileHint.textContent = busy
      ? this.options.localization.t("images.preparing")
      : this.#sourceDescription;
    if (busy) this.#error.textContent = "";
  }

  public override open(): void {
    super.open();
    if (!this.closed && !this.closing)
      this.#heightMotion = new DialogHeightMotion(
        this.modalEl,
        this.options.readMotion,
        this.options.observeMotion,
      );
  }

  protected override get phoneContentScroll(): HTMLElement {
    return this.#body;
  }

  #mutateView(update: () => void): void {
    if (this.#heightMotion === undefined || this.entering || this.closing) update();
    else this.#heightMotion.mutate(update);
  }

  protected override onClosing(): void {
    this.#spinner?.dispose();
    this.#heightMotion?.freeze();
    super.onClosing();
    void this.#pdf?.dispose().catch(() => undefined);
  }

  public override onClose(): void {
    this.#spinner?.dispose();
    this.#spinner = undefined;
    this.#heightMotion?.dispose();
    this.#heightMotion = undefined;
    void this.#pdf?.dispose().catch(() => undefined);
    this.#pdf = undefined;
    this.#preview = undefined;
    super.onClose();
  }
}
