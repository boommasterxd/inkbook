import { calculateElementBounds } from "../../../domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../../domain/schema/public";
import type { SnappingSettingsV1 } from "../../../domain/settings/types";
import type { PointerSample } from "../../../editor/input/index";
import {
  connectedSelectionTransformPreview,
  exactConnectedSelectionIds,
  findSelectionHandle,
  layoutSelectionHandles,
  selectionOverlayContainsPoint,
  selectionOverlayGeometry,
  SelectionFrameSession,
  SelectionHandleSession,
  type SelectedElementGeometry,
  type OrientedSelectionFrame,
  type SelectionHandle,
  type SelectionHandlePreview,
  type SelectionPreviewTransform,
} from "../../../editor/selection/public";
import type { EditableDocumentModel } from "../vault-document-session";

import { selectedElements } from "./controller-elements";
import type { ActiveEditorHistory } from "./history";
import type { PreparedElementHistory } from "./prepared-element-history";
import type { ElementSceneStore } from "./scene-store";
import { selectionOverlayFill, selectionOverlayPaths } from "./selection-overlay-path";
import { selectionSnapGuidePath } from "./snap-marker-path";
import { selectionHandleAction } from "./selection-handle-action";
import { activeSnapFeatures } from "./snapping-settings";
import { pressureStrokeScalePreview } from "./pressure-stroke-preview";

const HANDLE_RADIUS_PIXELS = 13;
const INTERIOR_HANDLE_RADIUS_PIXELS = 10;
const PEN_HANDLE_RADIUS_PIXELS = 16;
const TOUCH_HANDLE_RADIUS_PIXELS = 24;

export interface ActiveEditorHandleInteractionOptions {
  readonly history: ActiveEditorHistory;
  readonly layout?: {
    begin(): void;
    finish(committed: boolean, previewMaximumBottom?: number): void;
    updateBottom(maximumBottom: number): void;
  };
  readonly model: EditableDocumentModel;
  readonly pageToScreen: (point: PointV1) => PointV1;
  readonly preparedHistory: PreparedElementHistory;
  readonly renderer: HandleInteractionRenderer;
  readonly sceneStore: ElementSceneStore;
  readonly selectionFrames?: SelectionFrameSession;
  readonly selection: () => ReadonlySet<string>;
  readonly snapping?: () => SnappingSettingsV1;
  readonly zoom: () => number;
}

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

interface ActiveHandleGesture {
  readonly grabOffset: PointV1;
  readonly ids: readonly string[];
  readonly pointerId: number;
  readonly pointerType: PointerSample["pointerType"];
  readonly pressureStrokeIds: ReadonlySet<string>;
  readonly selected: readonly SelectedElementGeometry[];
  readonly frame: OrientedSelectionFrame | null;
  readonly selectedIds: ReadonlySet<string>;
  readonly session: SelectionHandleSession;
  readonly snapping: SnappingSettingsV1 | undefined;
}

export class ActiveEditorHandleInteraction {
  readonly #history: ActiveEditorHistory;
  readonly #layout: ActiveEditorHandleInteractionOptions["layout"];
  readonly #model: EditableDocumentModel;
  readonly #pageToScreen: (point: PointV1) => PointV1;
  readonly #preparedHistory: PreparedElementHistory;
  readonly #renderer: HandleInteractionRenderer;
  readonly #sceneStore: ElementSceneStore;
  readonly #selectionFrames: SelectionFrameSession;
  readonly #selection: () => ReadonlySet<string>;
  readonly #snapping: () => SnappingSettingsV1 | undefined;
  readonly #zoom: () => number;
  #active: ActiveHandleGesture | undefined;
  #previewMaximumBottom: number | undefined;
  #version = 0;

  public constructor(options: ActiveEditorHandleInteractionOptions) {
    this.#history = options.history;
    this.#layout = options.layout;
    this.#model = options.model;
    this.#pageToScreen = options.pageToScreen;
    this.#preparedHistory = options.preparedHistory;
    this.#renderer = options.renderer;
    this.#sceneStore = options.sceneStore;
    this.#selectionFrames = options.selectionFrames ?? new SelectionFrameSession();
    this.#selection = options.selection;
    this.#snapping = options.snapping ?? (() => undefined);
    this.#zoom = options.zoom;
  }

  public get activePointerId(): number | undefined {
    return this.#active?.pointerId;
  }

  public get activePointerType(): PointerSample["pointerType"] | undefined {
    return this.#active?.pointerType;
  }

  public cancel(pointerId?: number): boolean {
    const active = this.#active;
    if (active === undefined || (pointerId !== undefined && active.pointerId !== pointerId)) {
      return false;
    }
    active.session.cancel();
    this.#layout?.finish(false);
    this.#finish();
    return true;
  }

  public dispose(): void {
    this.cancel();
    this.#renderer.clearElementPreviews();
    this.#renderer.setSelectionOverlayPath(null);
    this.#renderer.setSnapMarkerPath(null);
  }

  public pointerDown(
    pointer: PointerSample,
    uniformScale = false,
    snappingInverted = false,
  ): boolean {
    if (this.#active !== undefined) return false;
    const selected = this.#selectedGeometry();
    const frame = this.#selectionFrames.current(selected);
    const handles = layoutSelectionHandles(selected, { frame, zoom: this.#zoom() });
    const handle = findSelectionHandle(
      handles,
      pointer,
      this.#zoom(),
      pointerHandleRadiusPixels(selected, frame, pointer, this.#zoom()),
    );
    if (handle === null) return false;
    const elements = selected.map(({ element }) => element);
    const selectedIds = new Set(elements.map(({ id }) => id));
    const action = selectionHandleAction(handle, selected, frame);
    const sessionStart = handleSessionStart(handle);
    const configuredSnapping = this.#snapping();
    const snapping =
      configuredSnapping === undefined ? undefined : structuredClone(configuredSnapping);
    this.#active = {
      ids: elements.map(({ id }) => id),
      frame,
      grabOffset: {
        x: pointer.x - sessionStart.x,
        y: pointer.y - sessionStart.y,
      },
      pointerId: pointer.pointerId,
      pointerType: pointer.pointerType,
      pressureStrokeIds: new Set(
        elements
          .filter((element) => element.kind === "stroke" && element.style.pressureEnabled)
          .map(({ id }) => id),
      ),
      selected,
      selectedIds,
      snapping,
      session: new SelectionHandleSession({
        action,
        elements,
        planner: this.#model.store,
        snap: {
          canConnect: (sourceId, targetId) => this.#sceneStore.canConnect(sourceId, targetId),
          features: activeSnapFeatures(snapping, snappingInverted),
          pointerType: pointer.pointerType,
          spatial: { query: (bounds, sink) => this.#sceneStore.query(bounds, sink) },
          targets: {
            get: (id) => this.#sceneStore.getSnapTarget(id),
          },
          zoom: this.#zoom(),
        },
        startPointer: sessionStart,
        uniformScale,
      }),
    };
    this.#model.setGestureActive(true);
    this.#previewMaximumBottom = undefined;
    this.#layout?.begin();
    return true;
  }

  public pointerMove(
    pointer: PointerSample,
    uniformScale = false,
    snappingInverted = false,
  ): boolean {
    const active = this.#active;
    if (active === undefined || active.pointerId !== pointer.pointerId) return false;
    const preview = active.session.update(
      {
        x: pointer.x - active.grabOffset.x,
        y: pointer.y - active.grabOffset.y,
      },
      {
        snapFeatures: activeSnapFeatures(active.snapping, snappingInverted),
        uniformScale,
      },
    );
    const connected = this.#connectedPreview(active, preview);
    const pressure = pressureStrokeScalePreview(active.selected, active.pressureStrokeIds, preview);
    this.#updatePreviewBottom(active, preview, connected.elements);
    this.#renderTransform(
      active.ids.filter(
        (id) => !connected.selectedPreviewIds.has(id) && !pressure.exactPreviewIds.has(id),
      ),
      preview.transform,
    );
    this.#renderPreview(active, preview, connected, pressure.elements);
    return true;
  }

  public pointerUp(pointerId: number): boolean {
    const active = this.#active;
    if (active === undefined || active.pointerId !== pointerId) return false;
    const commit = active.session.prepareCommit();
    const effect = this.#selectionFrames.transition(active.frame, active.session.preview.transform);
    if (commit.status === "ready") {
      const ids = commit.previous.map(({ id }) => id);
      const previewCommit = this.#renderer.beginPreviewCommit?.();
      if (previewCommit === undefined) this.#renderer.suppressMotionForNextDelta(ids);
      const armed = previewCommit?.arm(ids) ?? true;
      const committed =
        armed && this.#history.replace(commit.previous, commit.replacements, effect);
      if (!committed) previewCommit?.cancel();
      this.#layout?.finish(committed, this.#previewMaximumBottom);
    } else if (commit.status === "time-sliced-required") {
      const previewMaximumBottom = this.#previewMaximumBottom;
      const accepted = this.#preparedHistory.commitHandle(
        active.session,
        (committed) => {
          this.#layout?.finish(committed, previewMaximumBottom);
        },
        effect,
      );
      if (!accepted) this.#layout?.finish(false);
    } else {
      this.#layout?.finish(false);
    }
    this.#finish();
    return true;
  }

  public renderSelection(): void {
    if (this.#active !== undefined) return;
    const selected = this.#selectedGeometry();
    this.#renderGeometry(selected, null, null, this.#selectionFrames.current(selected));
  }

  #finish(): void {
    this.#active = undefined;
    this.#previewMaximumBottom = undefined;
    this.#model.setGestureActive(false);
    this.#renderer.clearPreviewTransforms();
    this.#renderer.clearElementPreviews();
    this.renderSelection();
  }

  #updatePreviewBottom(
    active: ActiveHandleGesture,
    preview: SelectionHandlePreview,
    connectedElements: readonly InkElementV1[],
  ): void {
    let maximumBottom = Number.NEGATIVE_INFINITY;
    for (const element of preview.exactElements) {
      maximumBottom = Math.max(maximumBottom, calculateElementBounds(element).maxY);
    }
    for (const element of connectedElements) {
      maximumBottom = Math.max(maximumBottom, calculateElementBounds(element).maxY);
    }
    if (preview.transform !== null) {
      const outline = selectionOverlayGeometry(
        active.selected,
        this.#zoom(),
        preview.transform,
        active.frame,
      )?.outline;
      if (outline?.kind === "linear") {
        maximumBottom = Math.max(
          maximumBottom,
          outline.start.y,
          outline.end.y,
          outline.bend?.y ?? Number.NEGATIVE_INFINITY,
        );
      } else if (outline !== undefined) {
        for (const point of outline.points) maximumBottom = Math.max(maximumBottom, point.y);
      }
    }
    if (!Number.isFinite(maximumBottom)) return;
    this.#previewMaximumBottom = Math.max(
      this.#previewMaximumBottom ?? maximumBottom,
      maximumBottom,
    );
    this.#layout?.updateBottom(this.#previewMaximumBottom);
  }

  #renderPreview(
    active: ActiveHandleGesture,
    preview: SelectionHandlePreview,
    connected: {
      readonly elements: readonly InkElementV1[];
      readonly selectedPreviewIds: ReadonlySet<string>;
    },
    pressureElements: readonly InkElementV1[],
  ): void {
    const exact = preview.exactElements
      .filter(({ id }) => active.selectedIds.has(id))
      .map((element) => ({ bounds: calculateElementBounds(element), element }));
    const exactOverlay =
      preview.transform === null || connected.selectedPreviewIds.size > 0 ? exact : [];
    const basePreviewElements = preview.exactPreviewTruncated
      ? connected.elements
      : preview.transform === null
        ? preview.exactElements
        : preview.exactElements.filter(
            ({ id }) => !active.selectedIds.has(id) || connected.selectedPreviewIds.has(id),
          );
    const previewElements = [...basePreviewElements, ...pressureElements];
    this.#version += 1;
    this.#renderer.setElementPreviews(previewElements, this.#version);
    this.#renderGeometry(
      exactOverlay.length === 0 ? active.selected : exactOverlay,
      preview.snapGuide,
      exactOverlay.length === 0 ? preview.transform : null,
      exactOverlay.length === 0 ? active.frame : null,
    );
  }

  #connectedPreview(
    active: ActiveHandleGesture,
    preview: SelectionHandlePreview,
  ): {
    readonly elements: readonly InkElementV1[];
    readonly selectedPreviewIds: ReadonlySet<string>;
  } {
    if (preview.transform === null) return { elements: [], selectedPreviewIds: new Set() };
    if (!preview.exactPreviewTruncated) {
      return {
        elements: [],
        selectedPreviewIds: exactConnectedSelectionIds(preview.exactElements, active.selectedIds),
      };
    }
    return connectedSelectionTransformPreview(
      this.#model.store,
      active.selected.map(({ element }) => element),
      active.selectedIds,
      preview.transform,
    );
  }

  #renderGeometry(
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

  #renderTransform(ids: readonly string[], transform: SelectionPreviewTransform | null): void {
    this.#version += 1;
    this.#renderer.setPreviewTransform(
      ids,
      transformString(transform),
      this.#version,
      transform?.kind === "scale" ? "preserve" : "scale",
    );
  }

  #selectedGeometry(): SelectedElementGeometry[] {
    const selected = selectedElements(this.#sceneStore, this.#selection());
    const geometry: SelectedElementGeometry[] = [];
    for (const element of selected) {
      const bounds = this.#sceneStore.get(element.id)?.bounds;
      if (bounds !== undefined) geometry.push({ bounds, element });
    }
    return geometry;
  }
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

function pointerHandleRadiusPixels(
  selected: readonly SelectedElementGeometry[],
  frame: OrientedSelectionFrame | null,
  pointer: PointerSample,
  zoom: number,
): number {
  const radius = handleRadiusPixels(pointer.pointerType, zoom);
  if (!selectionOverlayContainsPoint(selected, pointer, frame)) return radius;
  const outline = selectionOverlayGeometry(selected, zoom, null, frame)?.outline;
  if (
    outline?.kind !== "polygon" ||
    polygonEdgeDistance(pointer, outline.points) * zoom <= INTERIOR_HANDLE_RADIUS_PIXELS
  ) {
    return radius;
  }
  return Math.min(radius, INTERIOR_HANDLE_RADIUS_PIXELS);
}

function polygonEdgeDistance(point: PointV1, vertices: readonly PointV1[]): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 0; index < vertices.length; index += 1) {
    const start = vertices[index];
    const end = vertices[(index + 1) % vertices.length];
    if (start === undefined || end === undefined) continue;
    const deltaX = end.x - start.x;
    const deltaY = end.y - start.y;
    const lengthSquared = deltaX * deltaX + deltaY * deltaY;
    const factor =
      lengthSquared === 0
        ? 0
        : Math.max(
            0,
            Math.min(
              1,
              ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / lengthSquared,
            ),
          );
    minimum = Math.min(
      minimum,
      Math.hypot(point.x - (start.x + factor * deltaX), point.y - (start.y + factor * deltaY)),
    );
  }
  return minimum;
}

function handleSessionStart(handle: SelectionHandle): PointV1 {
  return handle.point;
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
