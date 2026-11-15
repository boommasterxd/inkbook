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

  public constructor(
    private readonly container: HTMLElement,
    private readonly image: ImageElementV3,
    private readonly chromeHost = container,
  ) {
    this.#bounds = measureElementBox(container).contentBox;
    this.#measureOffset();
  }

  public measure(): void {
    this.#bounds = measureElementBox(this.container).contentBox;
    this.#measureOffset();
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

  public update(crop: ImageCropV3, outline: HTMLElement, actions: HTMLElement): void {
    const image = applyImageCrop(this.image, crop);
    const { x, zoom } = this.#camera;
    const origin = rotatePointClockwise(image, image.pivot, image.rotation);
    outline.style.transform = `translate(${(origin.x + x) * zoom + this.#offset.x}px, ${origin.y * zoom + this.#offset.y}px) rotate(${image.rotation}deg)`;
    outline.style.width = `${image.width * zoom}px`;
    outline.style.height = `${image.height * zoom}px`;
    const bounds = calculateElementBounds(image);
    const viewport = this.container.ownerDocument.defaultView?.visualViewport;
    const visibleTop = Math.max(-this.#offset.y, (viewport?.offsetTop ?? 0) - this.#bounds.top);
    const visibleBottom = Math.min(
      this.#bounds.height,
      (viewport?.height ?? this.#bounds.height) + (viewport?.offsetTop ?? 0) - this.#bounds.top,
    );
    const left = Math.max(
      8,
      Math.min(((bounds.minX + bounds.maxX + 2 * x) * zoom) / 2 - 48, this.#bounds.width - 104),
    );
    const top = Math.max(8 - this.#offset.y, visibleTop + 8, bounds.minY * zoom - 84);
    actions.style.transform = `translate(${left + this.#offset.x}px, ${Math.min(top, Math.max(8 - this.#offset.y, visibleBottom - 56)) + this.#offset.y}px)`;
    actions.hidden = bounds.maxY * zoom < visibleTop || bounds.minY * zoom > visibleBottom;
  }
}
