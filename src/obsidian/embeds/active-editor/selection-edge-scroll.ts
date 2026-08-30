import type { PointV1 } from "../../../domain/schema/public";

const SELECTION_EDGE_ZONE_PX = 24;

export interface SelectionEdgeViewport {
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
}

export interface SelectionEdgeAutoScrollerOptions {
  readonly cancelFrame: (frame: number) => void;
  readonly onFrame?: () => void;
  readonly onScroll: (delta: PointV1) => void;
  readonly readViewport: () => SelectionEdgeViewport;
  readonly requestFrame: (callback: FrameRequestCallback) => number;
}

const MAX_SCROLL_PER_FRAME = 16;

/** Drives bounded native scrolling while a selection remains near a visible edge. */
export class SelectionEdgeAutoScroller {
  readonly #options: SelectionEdgeAutoScrollerOptions;
  #frame: number | undefined;
  #pointer: PointV1 | undefined;

  public constructor(options: SelectionEdgeAutoScrollerOptions) {
    this.#options = options;
  }

  public finish(): void {
    if (this.#frame !== undefined) this.#options.cancelFrame(this.#frame);
    this.#frame = undefined;
    this.#pointer = undefined;
  }

  public update(screenPointer: PointV1): void {
    if (!Number.isFinite(screenPointer.x) || !Number.isFinite(screenPointer.y)) return;
    this.#pointer = screenPointer;
    const delta = this.#delta();
    if (delta !== undefined && this.#frame === undefined) this.#schedule();
  }

  #delta(): PointV1 | undefined {
    const pointer = this.#pointer;
    if (pointer === undefined) return undefined;
    const viewport = this.#options.readViewport();
    const x = edgeDelta(pointer.x, viewport.left, viewport.right);
    const y = edgeDelta(pointer.y, viewport.top, viewport.bottom);
    return x === 0 && y === 0 ? undefined : { x, y };
  }

  #schedule(): void {
    this.#frame = this.#options.requestFrame(() => {
      this.#frame = undefined;
      this.#options.onFrame?.();
      const delta = this.#delta();
      if (delta === undefined) return;
      this.#options.onScroll({ x: delta.x, y: delta.y });
      this.#schedule();
    });
  }
}

function edgeDelta(position: number, start: number, end: number): number {
  if (position <= start + SELECTION_EDGE_ZONE_PX) {
    return -scrollSpeed(start + SELECTION_EDGE_ZONE_PX - position);
  }
  if (position >= end - SELECTION_EDGE_ZONE_PX) {
    return scrollSpeed(position - (end - SELECTION_EDGE_ZONE_PX));
  }
  return 0;
}

function scrollSpeed(depth: number): number {
  return Math.min(MAX_SCROLL_PER_FRAME, Math.max(1, (depth / SELECTION_EDGE_ZONE_PX) * 8));
}
