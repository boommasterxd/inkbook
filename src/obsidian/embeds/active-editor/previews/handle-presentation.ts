import type { ProgressivePreviewPurpose } from "../../../../rendering/scene/presentation/connected-preview-cohort";
import { calculateElementBounds } from "../../../../domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../../../domain/schema/public";
import type { ProgressivePreviewTransform } from "../../../../rendering/scene/presentation/progressive-element-preview";
import type { PreviewBoundsTransform } from "../../../../rendering/scene/types";
import {
  createSelectionFrameAtRotation,
  selectionOverlayGeometry,
  type OrientedSelectionFrame,
  type SelectedElementGeometry,
  type SelectionHandlePreview,
  type ConnectedSelectionPreview,
  type SelectionOutline,
  type SelectionOverlayGeometry,
  type SelectionPreviewTransform,
} from "../../../../editor/selection/public";

import { selectionOverlayFill, selectionOverlayPaths } from "./selection-overlay-path";
import { selectionSnapGuidePath } from "./snap-marker-path";
import { selectionPreviewBounds } from "./selection-preview-bounds";

export interface HandleInteractionRenderer {
  beginPreviewCommit?(): {
    arm(ids: readonly string[]): boolean;
    cancel(): void;
  };
  clearElementPreviews(): void;
  clearPreviewTransforms(): void;
  clearProgressiveElementPreviews?(): void;
  flushPointerFeedbackFrame(): void;
  setElementPreviews(elements: readonly InkElementV1[], version: number): void;
  setProgressiveElementPreviews?(
    ids: readonly string[],
    materialize: (id: string) => InkElementV1 | undefined,
    version: number,
    feedback?: ProgressivePreviewTransform,
    purpose?: ProgressivePreviewPurpose,
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
    transformBounds?: PreviewBoundsTransform,
  ): void;
  suppressMotionForNextDelta(ids: readonly string[]): void;
}

interface HandlePreviewContext {
  readonly frame: OrientedSelectionFrame | null;
  readonly selected: readonly SelectedElementGeometry[];
  readonly selectedIds: ReadonlySet<string>;
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
    geometry: SelectionOverlayGeometry | null,
    snap: SelectionHandlePreview["snapGuide"] = null,
  ): SelectionOutline | null {
    const paths = selectionOverlayPaths(
      selected,
      {
        pageToScreen: this.#pageToScreen,
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
    connected: ConnectedSelectionPreview,
    scaleElements: readonly InkElementV1[],
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
    const basePreviewElements =
      preview.transform === null
        ? uniquePreviewElements(preview.exactElements, connected.elements)
        : preview.exactPreviewTruncated
          ? connected.elements
          : preview.exactElements.filter(
              ({ id }) => !context.selectedIds.has(id) || connected.selectedPreviewIds.has(id),
            );
    this.#version += 1;
    this.#renderer.setElementPreviews(
      uniquePreviewElements(basePreviewElements, scaleElements),
      this.#version,
    );
    this.#renderConnectedPreview(connected, preview.transform);
    const previewFrame = exactOverlay.length === 0 ? preview.previewFrame : null;
    const selected = exactOverlay.length === 0 ? context.selected : exactOverlay;
    const geometry = selectionOverlayGeometry(
      selected,
      this.#zoom(),
      exactOverlay.length === 0 && previewFrame === null ? preview.transform : null,
      exactOverlay.length === 0 ? (previewFrame ?? context.frame) : exactFrame,
    );
    const outline = this.renderGeometry(selected, geometry, preview.snapGuide);
    return previewMaximumBottom(exactGeometry, connected.elements, outline);
  }

  #renderConnectedPreview(
    connected: ConnectedSelectionPreview,
    transform: SelectionPreviewTransform | null,
  ): void {
    if (connected.progressive !== undefined && transform?.kind !== "scale") {
      this.#renderer.setProgressiveElementPreviews?.(
        connected.progressive.ids,
        connected.progressive.materialize,
        this.#version,
        undefined,
        "connected",
      );
    }
  }

  public renderProgressive(
    ids: readonly string[],
    materialize: (id: string) => InkElementV1 | undefined,
    transform: Extract<SelectionPreviewTransform, { kind: "scale" }>,
    connected?: ProgressivePreviewPurpose,
  ): void {
    this.#version += 1;
    const inverse = transformString({
      ...transform,
      delta: { x: 0, y: 0 },
      factors: { x: 1 / transform.factors.x, y: 1 / transform.factors.y },
    });
    this.#renderer.setProgressiveElementPreviews?.(
      ids,
      materialize,
      this.#version,
      {
        transformBounds: selectionPreviewBounds(transform),
        transform: transformString(transform)!,
        inverse: `${inverse} translate(${String(-transform.delta.x)} ${String(-transform.delta.y)})`,
      },
      connected,
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
      transform === null ? undefined : selectionPreviewBounds(transform),
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
