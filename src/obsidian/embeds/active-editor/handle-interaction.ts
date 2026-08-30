import {
  calculateElementBounds,
  rotatePointClockwise,
  type Bounds,
} from "../../../domain/geometry/public";
import type { BoxAnchorV1, InkElementV1, PointV1 } from "../../../domain/schema/public";
import type { PointerSample } from "../../../editor/input/index";
import {
  connectedSelectionTransformPreview,
  exactConnectedSelectionIds,
  findSelectionHandle,
  layoutSelectionHandles,
  oppositeElementHandlePoint,
  selectionBounds,
  SelectionHandleSession,
  type SelectedElementGeometry,
  type SelectionHandle,
  type SelectionHandleAction,
  type SelectionHandlePreview,
  type SelectionPreviewTransform,
} from "../../../editor/selection/public";
import type { EditableDocumentModel } from "../vault-document-session";

import { selectedElements } from "./controller-elements";
import type { ActiveEditorHistory } from "./history";
import type { PreparedElementHistory } from "./prepared-element-history";
import type { ElementSceneStore } from "./scene-store";
import { selectionOverlayFill, selectionOverlayPath } from "./selection-overlay-path";
import { selectionSnapGuidePath } from "./snap-marker-path";

const HANDLE_RADIUS_PIXELS = 13;
const PEN_HANDLE_RADIUS_PIXELS = 16;
const TOUCH_HANDLE_RADIUS_PIXELS = 24;

export interface ActiveEditorHandleInteractionOptions {
  readonly history: ActiveEditorHistory;
  readonly model: EditableDocumentModel;
  readonly pageToScreen: (point: PointV1) => PointV1;
  readonly preparedHistory: PreparedElementHistory;
  readonly renderer: HandleInteractionRenderer;
  readonly sceneStore: ElementSceneStore;
  readonly selection: () => ReadonlySet<string>;
  readonly zoom: () => number;
}

export interface HandleInteractionRenderer {
  clearElementPreviews(): void;
  clearPreviewTransforms(): void;
  setElementPreviews(elements: readonly InkElementV1[], version: number): void;
  setSelectionOverlayPath(d: string | null, fill?: "accent" | "none"): void;
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
  readonly selected: readonly SelectedElementGeometry[];
  readonly selectedIds: ReadonlySet<string>;
  readonly session: SelectionHandleSession;
}

export class ActiveEditorHandleInteraction {
  readonly #history: ActiveEditorHistory;
  readonly #model: EditableDocumentModel;
  readonly #pageToScreen: (point: PointV1) => PointV1;
  readonly #preparedHistory: PreparedElementHistory;
  readonly #renderer: HandleInteractionRenderer;
  readonly #sceneStore: ElementSceneStore;
  readonly #selection: () => ReadonlySet<string>;
  readonly #zoom: () => number;
  #active: ActiveHandleGesture | undefined;
  #version = 0;

  public constructor(options: ActiveEditorHandleInteractionOptions) {
    this.#history = options.history;
    this.#model = options.model;
    this.#pageToScreen = options.pageToScreen;
    this.#preparedHistory = options.preparedHistory;
    this.#renderer = options.renderer;
    this.#sceneStore = options.sceneStore;
    this.#selection = options.selection;
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
    this.#finish();
    return true;
  }

  public dispose(): void {
    this.cancel();
    this.#renderer.clearElementPreviews();
    this.#renderer.setSelectionOverlayPath(null);
    this.#renderer.setSnapMarkerPath(null);
  }

  public pointerDown(pointer: PointerSample): boolean {
    if (this.#active !== undefined) return false;
    const selected = this.#selectedGeometry();
    const handles = layoutSelectionHandles(selected, { zoom: this.#zoom() });
    const handle = findSelectionHandle(
      handles,
      pointer,
      this.#zoom(),
      handleRadiusPixels(pointer.pointerType, this.#zoom()),
    );
    if (handle === null) return false;
    const elements = selected.map(({ element }) => element);
    const selectedIds = new Set(elements.map(({ id }) => id));
    const action = handleAction(handle, selected);
    const sessionStart = handleSessionStart(handle, selected);
    this.#active = {
      ids: elements.map(({ id }) => id),
      grabOffset: {
        x: pointer.x - sessionStart.x,
        y: pointer.y - sessionStart.y,
      },
      pointerId: pointer.pointerId,
      pointerType: pointer.pointerType,
      selected,
      selectedIds,
      session: new SelectionHandleSession({
        action,
        elements,
        planner: this.#model.store,
        snap: {
          pointerType: pointer.pointerType,
          spatial: { query: (bounds, sink) => this.#sceneStore.query(bounds, sink) },
          targets: {
            get: (id) => this.#sceneStore.getSnapTarget(id),
          },
          zoom: this.#zoom(),
        },
        startPointer: sessionStart,
      }),
    };
    this.#model.setGestureActive(true);
    return true;
  }

  public pointerMove(pointer: PointerSample): boolean {
    const active = this.#active;
    if (active === undefined || active.pointerId !== pointer.pointerId) return false;
    const preview = active.session.update({
      x: pointer.x - active.grabOffset.x,
      y: pointer.y - active.grabOffset.y,
    });
    const connected = this.#connectedPreview(active, preview);
    this.#renderTransform(
      active.ids.filter((id) => !connected.selectedPreviewIds.has(id)),
      preview.transform,
    );
    this.#renderPreview(active, preview, connected);
    return true;
  }

  public pointerUp(pointerId: number): boolean {
    const active = this.#active;
    if (active === undefined || active.pointerId !== pointerId) return false;
    const commit = active.session.prepareCommit();
    if (commit.status === "ready") {
      this.#renderer.suppressMotionForNextDelta(commit.previous.map(({ id }) => id));
      this.#history.replace(commit.previous, commit.replacements);
    } else if (commit.status === "time-sliced-required") {
      this.#preparedHistory.commitHandle(active.session);
    }
    this.#finish();
    return true;
  }

  public renderSelection(): void {
    if (this.#active !== undefined) return;
    this.#renderGeometry(this.#selectedGeometry(), null);
  }

  #finish(): void {
    this.#active = undefined;
    this.#model.setGestureActive(false);
    this.#renderer.clearPreviewTransforms();
    this.#renderer.clearElementPreviews();
    this.renderSelection();
  }

  #renderPreview(
    active: ActiveHandleGesture,
    preview: SelectionHandlePreview,
    connected: {
      readonly elements: readonly InkElementV1[];
      readonly selectedPreviewIds: ReadonlySet<string>;
    },
  ): void {
    const exact = preview.exactElements
      .filter(({ id }) => active.selectedIds.has(id))
      .map((element) => ({ bounds: calculateElementBounds(element), element }));
    const exactOverlay =
      preview.transform === null || connected.selectedPreviewIds.size > 0 ? exact : [];
    const previewElements = preview.exactPreviewTruncated
      ? connected.elements
      : preview.transform === null
        ? preview.exactElements
        : preview.exactElements.filter(
            ({ id }) => !active.selectedIds.has(id) || connected.selectedPreviewIds.has(id),
          );
    this.#version += 1;
    this.#renderer.setElementPreviews(previewElements, this.#version);
    this.#renderGeometry(
      exactOverlay.length === 0 ? active.selected : exactOverlay,
      preview.snapGuide,
      exactOverlay.length === 0 ? preview.transform : null,
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
  ): void {
    this.#renderer.setSelectionOverlayPath(
      selectionOverlayPath(selected, {
        pageToScreen: this.#pageToScreen,
        transform,
        zoom: this.#zoom(),
      }),
      selectionOverlayFill(selected),
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

function handleAction(
  handle: SelectionHandle,
  selected: readonly SelectedElementGeometry[],
): SelectionHandleAction {
  const only = selected.length === 1 ? selected[0]?.element : undefined;
  if (handle.kind === "shape-resize") {
    if (only === undefined) throw new Error("A shape handle requires one selected element.");
    return { elementId: only.id, kind: handle.kind, position: handle.position };
  }
  if (handle.kind === "linear-endpoint" || handle.kind === "linear-bend") {
    if (only === undefined) throw new Error("A linear handle requires one selected element.");
    return handle.kind === "linear-endpoint"
      ? { elementId: only.id, endpoint: handle.endpoint, kind: handle.kind }
      : { elementId: only.id, kind: handle.kind };
  }
  if (handle.kind === "coordinate-axis" || handle.kind === "coordinate-origin") {
    if (only === undefined) throw new Error("A coordinate handle requires one selected element.");
    return handle.kind === "coordinate-axis"
      ? { axisIndex: handle.axisIndex, elementId: only.id, kind: handle.kind }
      : { elementId: only.id, kind: handle.kind };
  }
  const bounds = selectionBounds(selected);
  if (bounds === null) throw new Error("Selection bounds are unavailable.");
  if (handle.kind === "rotate") {
    return { center: only?.pivot ?? boundsCenter(bounds), kind: handle.kind };
  }
  return {
    anchor:
      only === undefined
        ? oppositePoint(bounds, handle.position)
        : oppositeElementHandlePoint(only, handle.position),
    kind: handle.kind,
    position: handle.position,
  };
}

function handleSessionStart(
  handle: SelectionHandle,
  selected: readonly SelectedElementGeometry[],
): PointV1 {
  if (handle.kind !== "shape-resize") return handle.point;
  const element = selected.length === 1 ? selected[0]?.element : undefined;
  if (element?.kind !== "rectangle" && element?.kind !== "ellipse") {
    throw new TypeError("A shape resize handle requires one closed shape.");
  }
  const local = {
    x: handle.position.includes("left")
      ? element.x
      : handle.position.includes("right")
        ? element.x + element.width
        : element.x + element.width / 2,
    y: handle.position.startsWith("top")
      ? element.y
      : handle.position.startsWith("bottom")
        ? element.y + element.height
        : element.y + element.height / 2,
  };
  return rotatePointClockwise(local, element.pivot, element.rotation);
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

function boundsCenter(bounds: Bounds): PointV1 {
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}

function oppositePoint(bounds: Bounds, position: BoxAnchorV1): PointV1 {
  const opposite: Record<BoxAnchorV1, PointV1> = {
    "top-left": { x: bounds.maxX, y: bounds.maxY },
    "top-center": { x: (bounds.minX + bounds.maxX) / 2, y: bounds.maxY },
    "top-right": { x: bounds.minX, y: bounds.maxY },
    "middle-right": { x: bounds.minX, y: (bounds.minY + bounds.maxY) / 2 },
    "bottom-right": { x: bounds.minX, y: bounds.minY },
    "bottom-center": { x: (bounds.minX + bounds.maxX) / 2, y: bounds.minY },
    "bottom-left": { x: bounds.maxX, y: bounds.minY },
    "middle-left": { x: bounds.maxX, y: (bounds.minY + bounds.maxY) / 2 },
  };
  return opposite[position];
}
