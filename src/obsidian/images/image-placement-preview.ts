import { setIcon } from "obsidian";
import { initialImageSize, initialImageX } from "../../domain/images/image-insertion-size";
import { canonicalizeGeometryNumber, type ImageResourceV3 } from "../../domain/schema/public";
import { MOTION_TOKENS } from "../../rendering/motion/transitions";
import { playMenuMotion } from "../menus/feedback/menu-motion";
import { observeEffectiveMotion } from "../runtime/effective-motion";
import type { ImageImportDialogOptions } from "./image-dialog";

/** A writing-width section of the page. Switching placement reuses the displayed raster. */
export class ImagePlacementPreview {
  readonly #stage: HTMLElement;
  readonly #paper: HTMLElement;
  readonly #image: HTMLImageElement;
  readonly #lock: HTMLElement;
  readonly #releaseMotion: () => void;
  #cancelMotion: (() => void) | undefined;
  #reduced = true;
  #resource: ImageResourceV3 | undefined;
  #source: "image" | "pdf" = "image";

  public get raster(): HTMLImageElement {
    return this.#image;
  }

  public constructor(
    figure: HTMLElement,
    private readonly options: ImageImportDialogOptions,
  ) {
    this.#stage = figure.createDiv({ cls: "inkbook-image-import-stage" });
    this.#paper = this.#stage.createDiv({ cls: "inkbook-placement-paper" });
    const writing = this.#paper.createDiv({ cls: "inkbook-placement-writing" });
    const { margin, innerWidth, background } = options.page;
    const total = innerWidth + 2 * margin;
    writing.style.insetInline = `${(100 * margin) / total}%`;
    this.#paper.dataset.pattern = background.type;
    if (background.type !== "none")
      this.#paper.style.setProperty(
        "--inkbook-preview-grid",
        `${(100 * background.spacing) / total}cqw`,
      );
    this.#image = writing.createEl("img", {
      cls: "inkbook-image-import-preview",
      attr: { alt: options.localization.t("images.preview") },
    });
    this.#lock = this.#stage.createSpan({
      cls: "inkbook-placement-lock",
      attr: { "aria-hidden": "true" },
    });
    this.#lock.hidden = true;
    setIcon(this.#lock, "lock");
    this.#releaseMotion = observeEffectiveMotion(
      figure,
      options.readMotion,
      (reduced) => {
        this.#reduced = reduced;
        if (reduced) this.#stop();
      },
      options.observeMotion,
    );
  }

  public show(resource: ImageResourceV3, source: "image" | "pdf", locked: boolean): void {
    this.#stop();
    this.#resource = resource;
    this.#source = source;
    this.#stage.hidden = false;
    this.#image.width = resource.width;
    this.#image.height = resource.height;
    this.#image.src = `data:${resource.mimeType};base64,${resource.data}`;
    const { innerWidth, margin } = this.options.page;
    const fullHeight = (innerWidth * resource.height) / resource.width;
    const ratio = (innerWidth + margin * 2) / (fullHeight + margin * 2);
    this.#paper.style.setProperty("--inkbook-paper-ratio", String(Math.min(1.65, ratio)));
    this.setPlacement(locked, false);
  }

  public setPlacement(locked: boolean, animate = true): void {
    const resource = this.#resource;
    if (resource === undefined) return;
    const { page, centerX } = this.options;
    const placement = locked ? "page-width-locked" : "default";
    const width = canonicalizeGeometryNumber(
      initialImageSize(resource, page.innerWidth, this.#source, placement).width,
    );
    const x = initialImageX(width, page, centerX, placement) - page.margin;
    const target = `translateX(${(100 * x) / page.innerWidth}%) scale(${width / page.innerWidth})`;
    const image = this.#image;
    const previous = this.#cancelMotion
      ? image.ownerDocument.defaultView?.getComputedStyle(image).transform
      : image.style.transform;
    this.#stop();
    image.style.transform = target;
    this.#lock.hidden = !locked;
    if (animate && !this.#reduced && previous && previous !== target)
      this.#cancelMotion = playMenuMotion(
        image,
        { transform: [previous, target] },
        MOTION_TOKENS.surface,
      );
  }

  public clear(): void {
    this.#stop();
    this.#resource = undefined;
    this.#image.removeAttribute("src");
    this.#stage.hidden = true;
  }

  public dispose(): void {
    this.clear();
    this.#releaseMotion();
  }

  #stop(): void {
    this.#cancelMotion?.();
    this.#cancelMotion = undefined;
  }
}
