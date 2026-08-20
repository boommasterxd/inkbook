import type { ScreenPoint } from "../../../input/phase-zero";

const MIN_ZOOM_PERCENT = 50;
const MAX_ZOOM_PERCENT = 400;
const DEFAULT_ZOOM_PERCENT = 100;
const WHEEL_DELTA_LINE = 1;
const WHEEL_DELTA_PAGE = 2;
const WHEEL_LINE_PIXELS = 16;
const WHEEL_PAGE_FALLBACK_PIXELS = 800;
const MAX_WHEEL_DELTA_PIXELS = 120;
const WHEEL_ZOOM_SENSITIVITY = 0.01;
const TOUCH_ZOOM_EXPONENT = 2;

export class PhaseZeroViewZoom {
  #zoomPercent = DEFAULT_ZOOM_PERCENT;
  #panX = 0;
  #panY = 0;

  public constructor(
    private readonly container: HTMLElement,
    private readonly svg: SVGSVGElement,
  ) {}

  public get zoomPercent(): number {
    return this.#zoomPercent;
  }

  public get panX(): number {
    return this.#panX;
  }

  public get panY(): number {
    return this.#panY;
  }

  public wheel(event: WheelEvent): void {
    if (!event.ctrlKey || event.defaultPrevented) return;
    const deltaPixels = normalizeWheelDelta(
      event.deltaY,
      event.deltaMode,
      this.container.clientHeight,
    );
    if (deltaPixels === undefined || deltaPixels === 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.scale(Math.exp(-deltaPixels * WHEEL_ZOOM_SENSITIVITY));
  }

  public scale(scaleDelta: number): void {
    if (!Number.isFinite(scaleDelta) || scaleDelta <= 0) return;
    const nextZoom = clamp(
      this.#zoomPercent * scaleDelta,
      MIN_ZOOM_PERCENT,
      MAX_ZOOM_PERCENT,
    );
    if (nextZoom === this.#zoomPercent) return;
    this.#zoomPercent = nextZoom;
    this.#updateTransform();
  }

  public touch(scaleDelta: number): void {
    if (!Number.isFinite(scaleDelta) || scaleDelta <= 0) return;
    this.scale(scaleDelta ** TOUCH_ZOOM_EXPONENT);
  }

  public pan(delta: ScreenPoint): void {
    if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return;
    this.#panX += delta.x;
    this.#panY += delta.y;
    this.#updateTransform();
  }

  #updateTransform(): void {
    const scale = this.#zoomPercent / DEFAULT_ZOOM_PERCENT;
    this.svg.style.transform = `translate(${String(this.#panX)}px, ${String(this.#panY)}px) scale(${String(scale)})`;
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeWheelDelta(
  deltaY: number,
  deltaMode: number,
  containerHeight: number,
): number | undefined {
  if (!Number.isFinite(deltaY)) return undefined;
  const pagePixels =
    containerHeight > 0 ? containerHeight : WHEEL_PAGE_FALLBACK_PIXELS;
  let multiplier = 1;
  if (deltaMode === WHEEL_DELTA_LINE) multiplier = WHEEL_LINE_PIXELS;
  else if (deltaMode === WHEEL_DELTA_PAGE) multiplier = pagePixels;
  return clamp(
    deltaY * multiplier,
    -MAX_WHEEL_DELTA_PIXELS,
    MAX_WHEEL_DELTA_PIXELS,
  );
}
