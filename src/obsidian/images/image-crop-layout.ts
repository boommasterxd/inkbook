import { applyImageCrop } from "../../domain/images/image-crop";
import { calculateElementBounds } from "../../domain/geometry/bounds";
import { rotatePointClockwise } from "../../domain/geometry/primitives";
import type { ImageCropV3, ImageElementV3, PointV1 } from "../../domain/schema/public";
import type { SceneCamera } from "../../rendering/scene/types";
import { measureElementBox } from "../embeds/active-editor/layout/element-content-box";

/** One cached host measurement serves every pointer sample until layout changes. */
export class ImageCropLayout {
  #bounds: ReturnType<typeof measureElementBox>["contentBox"];
  #camera: SceneCamera = { x: 0, zoom: 1 };
  #offset = { x: 0, y: 0 };
  #panelSize = { width: 96, height: 48 };

  public constructor(
    private readonly container: HTMLElement,
    private readonly image: ImageElementV3,
    private readonly chromeHost: HTMLElement,
    private readonly panel: HTMLElement,
  ) {
    this.#bounds = measureElementBox(container).contentBox;
    this.#measureOffset();
    this.#measurePanel();
  }

  public measure(): void {
    this.#bounds = measureElementBox(this.container).contentBox;
    this.#measureOffset();
    this.#measurePanel();
  }

  #measurePanel(): void {
    const width = this.panel.offsetWidth;
    const height = this.panel.offsetHeight;
    if (width > 0 && height > 0) this.#panelSize = { width, height };
  }

  #measureOffset(): void {
    if (this.chromeHost === this.container) return;
    const host = measureElementBox(this.chromeHost).contentBox;
    this.#offset = { x: this.#bounds.left - host.left, y: this.#bounds.top - host.top };
  }

  public setCamera(camera: SceneCamera): void {
    this.#camera = camera;
  }

  public sourcePoint = (event: Pick<PointerEvent, "clientX" | "clientY">): PointV1 => {
    const { image } = this;
    const point = rotatePointClockwise(
      {
        x: (event.clientX - this.#bounds.left) / this.#camera.zoom - this.#camera.x,
        y: (event.clientY - this.#bounds.top) / this.#camera.zoom,
      },
      image.pivot,
      -image.rotation,
    );
    return {
      x: image.crop.x + ((point.x - image.x) * image.crop.width) / image.width,
      y: image.crop.y + ((point.y - image.y) * image.crop.height) / image.height,
    };
  };

  public update(crop: ImageCropV3, outline: HTMLElement): void {
    const image = applyImageCrop(this.image, crop);
    const { x, zoom } = this.#camera;
    const origin = rotatePointClockwise(image, image.pivot, image.rotation);
    outline.style.transform = `translate(${(origin.x + x) * zoom + this.#offset.x}px, ${origin.y * zoom + this.#offset.y}px) rotate(${image.rotation}deg)`;
    outline.style.width = `${image.width * zoom}px`;
    outline.style.height = `${image.height * zoom}px`;
    const bounds = calculateElementBounds(image);
    const ownerWindow = this.container.ownerDocument.defaultView;
    const viewport = ownerWindow?.visualViewport;
    const visibleTop = Math.max(-this.#offset.y, (viewport?.offsetTop ?? 0) - this.#bounds.top);
    const visibleBottom = Math.min(
      this.#bounds.height,
      (viewport?.height ?? ownerWindow?.innerHeight ?? this.#bounds.bottom) +
        (viewport?.offsetTop ?? 0) -
        this.#bounds.top,
    );
    const { width, height } = this.#panelSize;
    const center = ((bounds.minX + bounds.maxX + 2 * x) * zoom) / 2;
    const left = Math.max(8, Math.min(center - width / 2, this.#bounds.width - width - 8));
    const minimumTop = visibleTop + 8;
    const maximumTop = Math.max(minimumTop, visibleBottom - height - 8);
    const above = bounds.minY * zoom - height - 24;
    const below = bounds.maxY * zoom + 24;
    const preferredTop = above < minimumTop && below <= maximumTop ? below : above;
    const top = Math.max(minimumTop, Math.min(preferredTop, maximumTop));
    this.panel.style.transform = `translate(${left + this.#offset.x}px, ${top + this.#offset.y}px)`;
    this.panel.hidden = bounds.maxY * zoom < visibleTop || bounds.minY * zoom > visibleBottom;
  }
}
