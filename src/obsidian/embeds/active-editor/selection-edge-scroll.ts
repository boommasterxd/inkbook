import type { PointV1 } from "../../../domain/schema/public";

import { SELECTION_BOTTOM_EDGE_ZONE_PX } from "./page-layout";

export interface SelectionEdgeViewport {
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
}

export interface SelectionEdgeAutoScrollerOptions {
  readonly cancelFrame: (frame: number) => void;
  readonly onBottomEdge: (active: boolean) => void;
  readonly onScroll: (delta: PointV1) => void;
  readonly readViewport: () => SelectionEdgeViewport;
  readonly requestFrame: (callback: FrameRequestCallback) => number;
}

const MAX_SCROLL_PER_FRAME = 16;

/** Drives bounded native scrolling while a selection remains near a visible edge. */
export class SelectionEdgeAutoScroller {
  readonly #options: SelectionEdgeAutoScrollerOptions;
  #bottomEdgeActive = false;
  #frame: number | undefined;
  #pointer: PointV1 | undefined;

  public constructor(options: SelectionEdgeAutoScrollerOptions) {
    this.#options = options;
  }

  public finish(): void {
    if (this.#frame !== undefined) this.#options.cancelFrame(this.#frame);
    this.#frame = undefined;
    this.#pointer = undefined;
    if (this.#bottomEdgeActive) this.#reportBottomEdge(false);
  }

  public update(screenPointer: PointV1): void {
    if (!Number.isFinite(screenPointer.x) || !Number.isFinite(screenPointer.y)) return;
    this.#pointer = screenPointer;
    const delta = this.#delta();
    this.#reportBottomEdge(delta?.bottomEdge ?? false);
    if (delta !== undefined && this.#frame === undefined) this.#schedule();
  }

  #delta(): ({ readonly bottomEdge: boolean } & PointV1) | undefined {
    const pointer = this.#pointer;
    if (pointer === undefined) return undefined;
    const viewport = this.#options.readViewport();
    const x = edgeDelta(pointer.x, viewport.left, viewport.right);
    const y = edgeDelta(pointer.y, viewport.top, viewport.bottom);
    const bottomEdge = pointer.y >= viewport.bottom - SELECTION_BOTTOM_EDGE_ZONE_PX;
    return x === 0 && y === 0 ? undefined : { bottomEdge, x, y };
  }

  #schedule(): void {
    this.#frame = this.#options.requestFrame(() => {
      this.#frame = undefined;
      const delta = this.#delta();
      this.#reportBottomEdge(delta?.bottomEdge ?? false);
      if (delta === undefined) return;
      this.#options.onScroll({ x: delta.x, y: delta.y });
      this.#schedule();
    });
  }

  #reportBottomEdge(active: boolean): void {
    this.#bottomEdgeActive = active;
    this.#options.onBottomEdge(active);
  }
}

function edgeDelta(position: number, start: number, end: number): number {
  if (position <= start + SELECTION_BOTTOM_EDGE_ZONE_PX) {
    return -scrollSpeed(start + SELECTION_BOTTOM_EDGE_ZONE_PX - position);
  }
  if (position >= end - SELECTION_BOTTOM_EDGE_ZONE_PX) {
    return scrollSpeed(position - (end - SELECTION_BOTTOM_EDGE_ZONE_PX));
  }
  return 0;
}

function scrollSpeed(depth: number): number {
  return Math.min(MAX_SCROLL_PER_FRAME, Math.max(1, (depth / SELECTION_BOTTOM_EDGE_ZONE_PX) * 8));
}
