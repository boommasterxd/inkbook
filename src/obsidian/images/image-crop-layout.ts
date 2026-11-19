import { applyImageCrop } from "../../domain/images/image-crop";
import { calculateElementBounds } from "../../domain/geometry/bounds";
import { rotatePointClockwise, type Bounds } from "../../domain/geometry/primitives";
import type { ImageCropV3, ImageElementV3, PointV1 } from "../../domain/schema/public";
import type { SceneCamera } from "../../rendering/scene/types";
import { measureElementBox } from "../embeds/active-editor/layout/element-content-box";
import type { EditorChromeViewport } from "../embeds/active-editor/layout/editor-chrome-viewport";

const TARGET_SIZE = 44;
const CHROME_GAP = 8;

function clampPosition(value: number, start: number, end: number): number {
  return Math.max(start, Math.min(value, end));
}

/** One cached host measurement serves every pointer sample until layout changes. */
export class ImageCropLayout {
  #bounds: ReturnType<typeof measureElementBox>["contentBox"];
  #viewport: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  #camera: SceneCamera = { x: 0, zoom: 1 };
  #offset = { x: 0, y: 0 };
  #panelSize = { width: 96, height: 48 };
  readonly #rotationScale: number;

  public constructor(
    private readonly container: HTMLElement,
    private readonly image: ImageElementV3,
    private readonly chromeHost: HTMLElement,
    private readonly panel: HTMLElement,
    private readonly readViewport?: EditorChromeViewport["read"],
  ) {
    const angle = (image.rotation * Math.PI) / 180;
    this.#rotationScale = Math.abs(Math.cos(angle)) + Math.abs(Math.sin(angle));
    this.#bounds = measureElementBox(container).contentBox;
    this.#measureViewport();
    this.#measurePanel();
  }

  public measure(): void {
    this.#bounds = measureElementBox(this.container).contentBox;
    this.#measureViewport();
    this.#measurePanel();
  }

  #measurePanel(): void {
    const width = this.panel.offsetWidth;
    const height = this.panel.offsetHeight;
    if (width > 0 && height > 0) this.#panelSize = { width, height };
  }

  #measureViewport(): void {
    const box = this.#bounds;
    const host =
      this.chromeHost === this.container ? box : measureElementBox(this.chromeHost).contentBox;
    this.#offset = { x: box.left - host.left, y: box.top - host.top };
    const viewport = this.readViewport?.() ?? host;
    this.#viewport = {
      minX: Math.max(host.left, viewport.left) - box.left,
      minY: Math.max(host.top, viewport.top) - box.top,
      maxX: Math.min(host.right, box.right, viewport.right) - box.left,
      maxY: Math.min(host.bottom, box.bottom, viewport.bottom) - box.top,
    };
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
    const width = image.width * zoom;
    const height = image.height * zoom;
    const transform = `${this.#translation((origin.x + x) * zoom, origin.y * zoom)} rotate(${image.rotation}deg)`;
    outline.style.transform = transform;
    outline.style.width = `${width}px`;
    outline.style.height = `${height}px`;
    const bounds = calculateElementBounds(image);
    const projected = {
      minX: (bounds.minX + x) * zoom,
      minY: bounds.minY * zoom,
      maxX: (bounds.maxX + x) * zoom,
      maxY: bounds.maxY * zoom,
    };
    const panel = this.#preferredPanel(projected);
    this.panel.style.transform = this.#translation(panel.minX, panel.minY);
  }

  #translation(x: number, y: number): string {
    return `translate(${x + this.#offset.x}px, ${y + this.#offset.y}px)`;
  }

  #preferredPanel(crop: Bounds): Bounds {
    const { width, height } = this.#panelSize;
    const viewport = this.#viewport;
    const left = clampPosition(
      (crop.minX + crop.maxX - width) / 2,
      viewport.minX + CHROME_GAP,
      viewport.maxX - width - CHROME_GAP,
    );
    const minimumTop = viewport.minY + CHROME_GAP;
    const maximumTop = viewport.maxY - height - CHROME_GAP;
    const gap = Math.max(24, (TARGET_SIZE / 2) * this.#rotationScale + 2);
    const above = crop.minY - height - gap;
    const below = crop.maxY + gap;
    const preferredTop = above < minimumTop && below <= maximumTop ? below : above;
    const top = clampPosition(preferredTop, minimumTop, maximumTop);
    return { minX: left, minY: top, maxX: left + width, maxY: top + height };
  }
}
