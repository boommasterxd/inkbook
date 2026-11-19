import { applyImageCrop } from "../../domain/images/image-crop";
import { calculateElementBounds } from "../../domain/geometry/bounds";
import { rotatePointClockwise, type Bounds } from "../../domain/geometry/primitives";
import type { ImageCropV3, ImageElementV3, PointV1 } from "../../domain/schema/public";
import type { SceneCamera } from "../../rendering/scene/types";
import { measureElementBox } from "../embeds/active-editor/layout/element-content-box";
import type { EditorChromeViewport } from "../embeds/active-editor/layout/editor-chrome-viewport";

const TARGET_SIZE = 44;
const GUIDE_SPAN = TARGET_SIZE * 2;
const GUIDE_SIZE = GUIDE_SPAN + TARGET_SIZE;
const CHROME_GAP = 8;

function centeredBox(area: Bounds, width: number, height: number, center: PointV1): Bounds {
  const minX = clampPosition(center.x - width / 2, area.minX, area.maxX - width);
  const minY = clampPosition(center.y - height / 2, area.minY, area.maxY - height);
  return { minX, minY, maxX: minX + width, maxY: minY + height };
}

function clampPosition(value: number, start: number, end: number): number {
  return Math.max(start, Math.min(value, end));
}

function boxCenter(box: Bounds): PointV1 {
  return { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
}

function spacesAround(area: Bounds, box: Bounds, gap: number): Bounds[] {
  return [
    { ...area, maxY: Math.min(area.maxY, box.minY - gap) },
    { ...area, minY: Math.max(area.minY, box.maxY + gap) },
    { ...area, maxX: Math.min(area.maxX, box.minX - gap) },
    { ...area, minX: Math.max(area.minX, box.maxX + gap) },
  ];
}

function overlapArea(a: Bounds, b: Bounds): number {
  return (
    Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)) *
    Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY))
  );
}

function nearestGuide(spaces: Bounds[], size: number, crop: Bounds): Bounds | undefined {
  const center = boxCenter(crop);
  let best: Bounds | undefined;
  let bestOverlap = Infinity;
  let bestDistance = Infinity;
  for (const space of spaces) {
    if (space.maxX - space.minX < size || space.maxY - space.minY < size) continue;
    const candidate = centeredBox(space, size, size, center);
    const overlap = overlapArea(candidate, crop);
    const position = boxCenter(candidate);
    const distance = (center.x - position.x) ** 2 + (center.y - position.y) ** 2;
    if (overlap > bestOverlap || (overlap === bestOverlap && distance >= bestDistance)) continue;
    bestOverlap = overlap;
    bestDistance = distance;
    best = candidate;
  }
  return best;
}

function guideBesidePanel(
  viewport: Bounds,
  crop: Bounds,
  panel: Bounds,
  size: number,
): Bounds | undefined {
  const open = spacesAround(viewport, panel, 0);
  return (
    nearestGuide(
      open.flatMap((space) => spacesAround(space, crop, CHROME_GAP)),
      size,
      crop,
    ) ?? nearestGuide(open, size, crop)
  );
}

function compactPlacement(
  viewport: Bounds,
  crop: Bounds,
  preferredPanel: Bounds,
  size: number,
): { guide: Bounds; panel: Bounds } {
  const preferredGuide = guideBesidePanel(viewport, crop, preferredPanel, size);
  let bestOverlap = preferredGuide === undefined ? Infinity : overlapArea(preferredGuide, crop);
  if (preferredGuide !== undefined && bestOverlap === 0)
    return { guide: preferredGuide, panel: preferredPanel };

  // A centered panel can divide the viewport into strips too narrow for the whole guide.
  // Try the viewport corners before letting the guide obscure the draggable crop.
  const width = preferredPanel.maxX - preferredPanel.minX;
  const height = preferredPanel.maxY - preferredPanel.minY;
  const corners = [
    { x: viewport.minX, y: viewport.minY },
    { x: viewport.maxX, y: viewport.minY },
    { x: viewport.minX, y: viewport.maxY },
    { x: viewport.maxX, y: viewport.maxY },
  ];
  let best =
    preferredGuide === undefined ? undefined : { guide: preferredGuide, panel: preferredPanel };
  for (const corner of corners) {
    const panel = centeredBox(viewport, width, height, corner);
    const guide = guideBesidePanel(viewport, crop, panel, size);
    if (guide === undefined) continue;
    const overlap = overlapArea(guide, crop);
    if (overlap === 0) return { guide, panel };
    if (overlap >= bestOverlap) continue;
    best = { guide, panel };
    bestOverlap = overlap;
  }
  return (
    best ?? { guide: centeredBox(viewport, size, size, boxCenter(crop)), panel: preferredPanel }
  );
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

  public update(crop: ImageCropV3, outline: HTMLElement, grips: HTMLElement): void {
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
    let panel = this.#preferredPanel(projected);
    if (this.#needsCompact(projected, panel, width, height))
      panel = this.#showCompactGrips(grips, projected, panel);
    else this.#showDirectGrips(grips, transform, width, height);
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

  #needsCompact(crop: Bounds, panel: Bounds, width: number, height: number): boolean {
    if (width < GUIDE_SPAN || height < GUIDE_SPAN) return true;
    const padding = (TARGET_SIZE / 2) * this.#rotationScale;
    const { minX, minY, maxX, maxY } = this.#viewport;
    const padded = {
      minX: crop.minX - padding,
      minY: crop.minY - padding,
      maxX: crop.maxX + padding,
      maxY: crop.maxY + padding,
    };
    return (
      padded.minX < minX ||
      padded.minY < minY ||
      padded.maxX > maxX ||
      padded.maxY > maxY ||
      overlapArea(padded, panel) > 0
    );
  }

  #showDirectGrips(grips: HTMLElement, transform: string, width: number, height: number): void {
    if (grips.dataset.compact !== undefined) delete grips.dataset.compact;
    grips.style.transform = transform;
    grips.style.width = `${width}px`;
    grips.style.height = `${height}px`;
  }

  #showCompactGrips(grips: HTMLElement, crop: Bounds, preferredPanel: Bounds): Bounds {
    const { minX, minY, maxX, maxY } = this.#viewport;
    const viewportWidth = maxX - minX;
    const viewportHeight = maxY - minY;
    const rotatedSize = GUIDE_SIZE * this.#rotationScale;
    const rotate =
      rotatedSize <= Math.min(viewportWidth, viewportHeight) &&
      (rotatedSize + this.#panelSize.width <= viewportWidth ||
        rotatedSize + this.#panelSize.height <= viewportHeight);
    const { guide, panel } = compactPlacement(
      this.#viewport,
      crop,
      preferredPanel,
      rotate ? rotatedSize : GUIDE_SIZE,
    );
    const { x, y } = boxCenter(guide);
    if (grips.dataset.compact !== "true") grips.dataset.compact = "true";
    const rotation = rotate ? this.image.rotation : 0;
    grips.style.transform = `${this.#translation(x, y)} rotate(${rotation}deg) translate(-50%, -50%)`;
    grips.style.width = `${GUIDE_SPAN}px`;
    grips.style.height = `${GUIDE_SPAN}px`;
    return panel;
  }
}
