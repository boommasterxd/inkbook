import { calculateElementBounds, pointSegmentDistance } from "../../../domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../../domain/schema/public";
import type { PointerSample } from "../../../editor/input/index";
import {
  selectionOverlayContainsPoint,
  selectionOverlayGeometry,
  type OrientedSelectionFrame,
  type SelectedElementGeometry,
  type SelectionHandlePreview,
  type SelectionPreviewTransform,
} from "../../../editor/selection/public";

import { selectionOverlayFill, selectionOverlayPaths } from "./selection-overlay-path";
import { selectionSnapGuidePath } from "./snap-marker-path";

const HANDLE_RADIUS_PIXELS = 13;
const INTERIOR_HANDLE_RADIUS_PIXELS = 10;
const PEN_HANDLE_RADIUS_PIXELS = 16;
const TOUCH_HANDLE_RADIUS_PIXELS = 24;

export interface HandleInteractionRenderer {
  beginPreviewCommit?(): {
    arm(ids: readonly string[]): boolean;
    cancel(): void;
  };
  clearElementPreviews(): void;
  clearPreviewTransforms(): void;
  setElementPreviews(elements: readonly InkElementV1[], version: number): void;
  setSelectionOverlayPath(
    d: string | null,
    fill?: "accent" | "none",
    handles?: string | null,
  ): void;
  setSnapMarkerPath(d: string | null): void;
  setPreviewTransform(
    ids: readonly string[],
    transform: string | null,
    version: number,
    strokeWidth?: "preserve" | "scale",
  ): void;
  suppressMotionForNextDelta(ids: readonly string[]): void;
}

interface HandlePreviewContext {
  readonly frame: OrientedSelectionFrame | null;
  readonly selected: readonly SelectedElementGeometry[];
  readonly selectedIds: ReadonlySet<string>;
}

interface ConnectedHandlePreview {
  readonly elements: readonly InkElementV1[];
  readonly selectedPreviewIds: ReadonlySet<string>;
}

export class SelectionHandlePresentation {
  readonly #pageToScreen: (point: PointV1) => PointV1;
  readonly #renderer: HandleInteractionRenderer;
  readonly #zoom: () => number;
  #version = 0;

  public constructor(
    renderer: HandleInteractionRenderer,
    pageToScreen: (point: PointV1) => PointV1,
    zoom: () => number,
  ) {
    this.#renderer = renderer;
    this.#pageToScreen = pageToScreen;
    this.#zoom = zoom;
  }

  public clearPreviews(): void {
    this.#renderer.clearPreviewTransforms();
    this.#renderer.clearElementPreviews();
  }

  public dispose(): void {
    this.clearPreviews();
    this.#renderer.setSelectionOverlayPath(null);
    this.#renderer.setSnapMarkerPath(null);
  }

  public renderGeometry(
    selected: readonly SelectedElementGeometry[],
    snap: SelectionHandlePreview["snapGuide"],
    transform: SelectionPreviewTransform | null = null,
    frame: OrientedSelectionFrame | null = null,
  ): void {
    const paths = selectionOverlayPaths(selected, {
      pageToScreen: this.#pageToScreen,
      frame,
      transform,
      zoom: this.#zoom(),
    });
    this.#renderer.setSelectionOverlayPath(
      paths.outline,
      selectionOverlayFill(selected),
      paths.handles,
    );
    this.#renderer.setSnapMarkerPath(
      snap === null ? null : selectionSnapGuidePath(snap, this.#pageToScreen),
    );
  }

  public renderPreview(
    context: HandlePreviewContext,
    preview: SelectionHandlePreview,
    connected: ConnectedHandlePreview,
    pressureElements: readonly InkElementV1[],
  ): void {
    const exact = preview.exactElements
      .filter(({ id }) => context.selectedIds.has(id))
      .map((element) => ({ bounds: calculateElementBounds(element), element }));
    const exactOverlay =
      preview.transform === null || connected.selectedPreviewIds.size > 0 ? exact : [];
    const basePreviewElements = preview.exactPreviewTruncated
      ? connected.elements
      : preview.transform === null
        ? preview.exactElements
        : preview.exactElements.filter(
            ({ id }) => !context.selectedIds.has(id) || connected.selectedPreviewIds.has(id),
          );
    this.#version += 1;
    this.#renderer.setElementPreviews([...basePreviewElements, ...pressureElements], this.#version);
    this.renderGeometry(
      exactOverlay.length === 0 ? context.selected : exactOverlay,
      preview.snapGuide,
      exactOverlay.length === 0 ? preview.transform : null,
      exactOverlay.length === 0 ? context.frame : null,
    );
  }

  public renderTransform(
    ids: readonly string[],
    transform: SelectionPreviewTransform | null,
  ): void {
    this.#version += 1;
    this.#renderer.setPreviewTransform(
      ids,
      transformString(transform),
      this.#version,
      transform?.kind === "scale" ? "preserve" : "scale",
    );
  }
}

export function pointerHandleRadiusPixels(
  selected: readonly SelectedElementGeometry[],
  frame: OrientedSelectionFrame | null,
  pointer: PointerSample,
  zoom: number,
): number {
  const radius = handleRadiusPixels(pointer.pointerType, zoom);
  if (!selectionOverlayContainsPoint(selected, pointer, frame)) return radius;
  const geometry = selectionOverlayGeometry(selected, zoom, null, frame)?.outline;
  if (
    geometry?.kind !== "polygon" ||
    polygonEdgeDistance(pointer, geometry.points) * zoom <= INTERIOR_HANDLE_RADIUS_PIXELS
  ) {
    return radius;
  }
  return Math.min(radius, INTERIOR_HANDLE_RADIUS_PIXELS);
}

function handleRadiusPixels(pointerType: PointerSample["pointerType"], zoom: number): number {
  const base =
    pointerType === "touch"
      ? TOUCH_HANDLE_RADIUS_PIXELS
      : pointerType === "pen"
        ? PEN_HANDLE_RADIUS_PIXELS
        : HANDLE_RADIUS_PIXELS;
  return Math.min(28, Math.max(11, base / Math.sqrt(zoom)));
}

function polygonEdgeDistance(point: PointV1, vertices: readonly PointV1[]): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 0; index < vertices.length; index += 1) {
    const start = vertices[index];
    const end = vertices[(index + 1) % vertices.length];
    if (start === undefined || end === undefined) continue;
    minimum = Math.min(minimum, pointSegmentDistance(point, start, end));
  }
  return minimum;
}

function transformString(transform: SelectionPreviewTransform | null): string | null {
  if (transform === null) return null;
  if (transform.kind === "translate") {
    return `translate(${String(transform.delta.x)} ${String(transform.delta.y)})`;
  }
  if (transform.kind === "rotate") {
    return `rotate(${String(transform.degrees)} ${String(transform.center.x)} ${String(transform.center.y)})`;
  }
  return `translate(${String(transform.anchor.x)} ${String(transform.anchor.y)}) rotate(${String(transform.rotation)}) scale(${String(transform.factors.x)} ${String(transform.factors.y)}) rotate(${String(-transform.rotation)}) translate(${String(-transform.anchor.x)} ${String(-transform.anchor.y)})`;
}
