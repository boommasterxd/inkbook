import { calculateElementBounds, pointSegmentDistance } from "../../../domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../../domain/schema/public";
import type { PointerSample } from "../../../editor/input/index";
import {
  createSelectionFrameAtRotation,
  selectionOverlayContainsPoint,
  selectionOverlayGeometry,
  type OrientedSelectionFrame,
  type SelectedElementGeometry,
  type SelectionHandlePreview,
  type SelectionOutline,
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
  flushPointerFeedbackFrame(): void;
  setElementPreviews(
    elements: readonly InkElementV1[],
    version: number,
    pressurePreviewIds?: ReadonlySet<string>,
  ): void;
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
  ): SelectionOutline | null {
    const geometry = selectionOverlayGeometry(selected, this.#zoom(), transform, frame);
    const paths = selectionOverlayPaths(
      selected,
      {
        pageToScreen: this.#pageToScreen,
        frame,
        transform,
        zoom: this.#zoom(),
      },
      geometry,
    );
    this.#renderer.setSelectionOverlayPath(
      paths.outline,
      selectionOverlayFill(selected),
      paths.handles,
    );
    this.#renderer.setSnapMarkerPath(
      snap === null ? null : selectionSnapGuidePath(snap, this.#pageToScreen),
    );
    return geometry?.outline ?? null;
  }

  public renderPreview(
    context: HandlePreviewContext,
    preview: SelectionHandlePreview,
    connected: ConnectedHandlePreview,
    scaleElements: readonly InkElementV1[],
    pressurePreviewIds?: ReadonlySet<string>,
  ): number | undefined {
    const exactGeometry = preview.exactElements.map((element) => ({
      bounds: calculateElementBounds(element),
      element,
    }));
    const exact = exactGeometry.filter(({ element }) => context.selectedIds.has(element.id));
    const exactOverlay =
      preview.transform === null ||
      preview.transform?.kind === "scale" ||
      connected.selectedPreviewIds.size > 0
        ? exact
        : [];
    const exactFrame =
      preview.transform?.kind === "scale" && preview.previewFrame !== null
        ? preview.previewFrame
        : exactOverlay.length > 1
          ? createSelectionFrameAtRotation(
              exactOverlay.map(({ element }) => element),
              context.frame?.rotation ?? 0,
            )
          : null;
    const basePreviewElements = preview.exactPreviewTruncated
      ? connected.elements
      : preview.transform === null
        ? preview.exactElements
        : preview.exactElements.filter(
            ({ id }) => !context.selectedIds.has(id) || connected.selectedPreviewIds.has(id),
          );
    this.#version += 1;
    this.#renderer.setElementPreviews(
      uniquePreviewElements(basePreviewElements, scaleElements),
      this.#version,
      pressurePreviewIds,
    );
    const previewFrame = exactOverlay.length === 0 ? preview.previewFrame : null;
    const outline = this.renderGeometry(
      exactOverlay.length === 0 ? context.selected : exactOverlay,
      preview.snapGuide,
      exactOverlay.length === 0 && previewFrame === null ? preview.transform : null,
      exactOverlay.length === 0 ? (previewFrame ?? context.frame) : exactFrame,
    );
    return previewMaximumBottom(exactGeometry, connected.elements, outline);
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

function previewMaximumBottom(
  exact: readonly SelectedElementGeometry[],
  connected: readonly InkElementV1[],
  outline: SelectionOutline | null,
): number | undefined {
  let maximum = Number.NEGATIVE_INFINITY;
  for (const { bounds } of exact) maximum = Math.max(maximum, bounds.maxY);
  for (const element of connected) {
    maximum = Math.max(maximum, calculateElementBounds(element).maxY);
  }
  if (outline?.kind === "linear") {
    maximum = Math.max(maximum, outline.start.y, outline.end.y, outline.bend?.y ?? maximum);
  } else if (outline !== null) {
    for (const point of outline.points) maximum = Math.max(maximum, point.y);
  }
  return Number.isFinite(maximum) ? maximum : undefined;
}

function uniquePreviewElements(
  base: readonly InkElementV1[],
  scale: readonly InkElementV1[],
): readonly InkElementV1[] {
  if (scale.length === 0) return base;
  if (base.length === 0) return scale;
  const scaleIds = new Set(scale.map(({ id }) => id));
  return [...base.filter(({ id }) => !scaleIds.has(id)), ...scale];
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
  return `translate(${String(transform.delta.x)} ${String(transform.delta.y)}) translate(${String(transform.anchor.x)} ${String(transform.anchor.y)}) rotate(${String(transform.rotation)}) scale(${String(transform.factors.x)} ${String(transform.factors.y)}) rotate(${String(-transform.rotation)}) translate(${String(-transform.anchor.x)} ${String(-transform.anchor.y)})`;
}
