import { IMAGE_IMPORT_RESOLUTIONS } from "../../domain/images/image-import-resolution";
import type { ImageRasterSize } from "../../domain/images/image-raster-size";
import type { Localization, Translator } from "../../domain/localization";
import type { ImageResourceV3 } from "../../domain/schema/public";
import type { PdfImageSource } from "./pdf-image-source";

const qualityMessages = {
  standard: "images.standard",
  high: "images.high",
  "very-high": "images.veryHigh",
  ultra: "images.ultra",
} as const;

/** One shared quality control for raster images and PDF pages, owned by the dialog. */
export class ImageImportResolutionControl {
  public readonly element: HTMLElement;
  public readonly select: HTMLSelectElement;
  readonly #label: HTMLElement;

  public constructor(
    parent: HTMLElement,
    private readonly localization: Localization,
  ) {
    this.element = parent.createDiv({ cls: "inkbook-image-import-resolution" });
    this.element.hidden = true;
    const label = this.element.createEl("label", { cls: "inkbook-image-field" });
    this.#label = label.createSpan({ text: localization.t("images.imageQuality") });
    this.select = label.createEl("select");
    for (const profile of IMAGE_IMPORT_RESOLUTIONS)
      this.select.createEl("option", { value: profile.id });
    this.select.value = "high";
    const hint = this.element.createEl("p", { text: localization.t("images.resolutionHint") });
    hint.id = `inkbook-image-resolution-${crypto.randomUUID()}`;
    this.select.setAttribute("aria-describedby", hint.id);
  }

  public show(pdf: boolean): void {
    const { t } = this.localization;
    this.element.hidden = false;
    this.#label.textContent = t(pdf ? "images.quality" : "images.imageQuality");
    for (const [index, profile] of IMAGE_IMPORT_RESOLUTIONS.entries())
      this.select.options.item(index)!.text = t(
        pdf ? "images.pdfResolutionOption" : "images.imageResolutionOption",
        {
          quality: t(qualityMessages[profile.id]),
          dpi: profile.dpi,
          megapixels: profile.maximumPixels / 1_000_000,
        },
      );
  }
}

export function imageResolutionDescription(
  t: Translator,
  resource: ImageResourceV3,
  options: {
    readonly resizedFrom?: ImageRasterSize | undefined;
    readonly resolution?: PdfImageSource["resolution"];
  },
): { readonly details: string; readonly dpi: string; readonly warning: string } {
  const { resolution, resizedFrom } = options;
  let warning = "";
  if (resizedFrom !== undefined)
    warning = t("images.resized", {
      sourceWidth: resizedFrom.width,
      sourceHeight: resizedFrom.height,
      width: resource.width,
      height: resource.height,
    });
  else if (resolution?.limited === true)
    warning = t("images.pdfResolutionLimited", { dpi: Math.round(resolution.dpi) });
  const details = t("images.details", {
    width: resource.width,
    height: resource.height,
  });
  const dpi =
    resolution === undefined ? "" : t("images.previewDpi", { dpi: Math.round(resolution.dpi) });
  return { details, dpi, warning };
}
