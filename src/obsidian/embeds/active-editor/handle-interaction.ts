import { calculateElementBounds, type Bounds } from "../../../domain/geometry/public";
import type { BoxAnchorV1, InkElementV1, PointV1 } from "../../../domain/schema/public";
import type { PointerSample } from "../../../editor/input/index";
import {
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

const HANDLE_RADIUS_PIXELS = 10;
const HANDLE_DRAW_RADIUS_PIXELS = 5;

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
  setSelectionOverlayPath(d: string | null): void;
  setSnapMarkerPath(d: string | null): void;
  setPreviewTransform(ids: readonly string[], transform: string | null, version: number): void;
  suppressMotionForNextDelta(ids: readonly string[]): void;
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
  #active:
    { ids: readonly string[]; pointerId: number; session: SelectionHandleSession } | undefined;
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
    const handle = findSelectionHandle(handles, pointer, this.#zoom(), HANDLE_RADIUS_PIXELS);
    if (handle === null) return false;
    const elements = selected.map(({ element }) => element);
    const action = handleAction(handle, selected);
    this.#active = {
      ids: elements.map(({ id }) => id),
      pointerId: pointer.pointerId,
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
        startPointer: pointer,
      }),
    };
    this.#model.setGestureActive(true);
    return true;
  }

  public pointerMove(pointer: PointerSample): boolean {
    const active = this.#active;
    if (active === undefined || active.pointerId !== pointer.pointerId) return false;
    const preview = active.session.update(pointer);
    this.#renderTransform(active.ids, preview.transform);
    this.#renderPreview(preview);
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

  #renderPreview(preview: SelectionHandlePreview): void {
    const selection = this.#selection();
    const exact = preview.exactElements
      .filter(({ id }) => selection.has(id))
      .map((element) => ({ bounds: calculateElementBounds(element), element }));
    const previewElements =
      preview.transform === null
        ? preview.exactElements
        : preview.exactElements.filter(({ id }) => !selection.has(id));
    this.#version += 1;
    this.#renderer.setElementPreviews(previewElements, this.#version);
    this.#renderGeometry(
      exact.length === 0 ? this.#selectedGeometry() : exact,
      preview.snapCandidate?.point ?? null,
    );
  }

  #renderGeometry(selected: readonly SelectedElementGeometry[], snap: PointV1 | null): void {
    const bounds = selectionBounds(selected);
    const handles = layoutSelectionHandles(selected, { zoom: this.#zoom() });
    const parts = bounds === null ? [] : [screenRect(bounds, this.#pageToScreen)];
    for (const handle of handles) parts.push(screenCircle(this.#pageToScreen(handle.point)));
    this.#renderer.setSelectionOverlayPath(parts.length === 0 ? null : parts.join(" "));
    this.#renderer.setSnapMarkerPath(snap === null ? null : screenSnap(this.#pageToScreen(snap)));
  }

  #renderTransform(ids: readonly string[], transform: SelectionPreviewTransform | null): void {
    this.#version += 1;
    this.#renderer.setPreviewTransform(ids, transformString(transform), this.#version);
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

function transformString(transform: SelectionPreviewTransform | null): string | null {
  if (transform === null) return null;
  if (transform.kind === "translate") {
    return `translate(${String(transform.delta.x)} ${String(transform.delta.y)})`;
  }
  if (transform.kind === "rotate") {
    const start = Math.atan2(
      transform.startPointer.y - transform.center.y,
      transform.startPointer.x - transform.center.x,
    );
    const current = Math.atan2(
      transform.currentPointer.y - transform.center.y,
      transform.currentPointer.x - transform.center.x,
    );
    return `rotate(${String(((current - start) * 180) / Math.PI)} ${String(transform.center.x)} ${String(transform.center.y)})`;
  }
  return `translate(${String(transform.anchor.x)} ${String(transform.anchor.y)}) rotate(${String(transform.rotation)}) scale(${String(transform.factors.x)} ${String(transform.factors.y)}) rotate(${String(-transform.rotation)}) translate(${String(-transform.anchor.x)} ${String(-transform.anchor.y)})`;
}

function screenRect(bounds: Bounds, project: (point: PointV1) => PointV1): string {
  const topLeft = project({ x: bounds.minX, y: bounds.minY });
  const bottomRight = project({ x: bounds.maxX, y: bounds.maxY });
  return `M ${String(topLeft.x)} ${String(topLeft.y)} L ${String(bottomRight.x)} ${String(topLeft.y)} L ${String(bottomRight.x)} ${String(bottomRight.y)} L ${String(topLeft.x)} ${String(bottomRight.y)} Z`;
}

function screenCircle(point: PointV1): string {
  const radius = HANDLE_DRAW_RADIUS_PIXELS;
  return `M ${String(point.x - radius)} ${String(point.y)} a ${radius} ${radius} 0 1 0 ${radius * 2} 0 a ${radius} ${radius} 0 1 0 ${-radius * 2} 0`;
}

function screenSnap(point: PointV1): string {
  const radius = HANDLE_DRAW_RADIUS_PIXELS * 1.5;
  return `M ${String(point.x - radius)} ${String(point.y)} L ${String(point.x + radius)} ${String(point.y)} M ${String(point.x)} ${String(point.y - radius)} L ${String(point.x)} ${String(point.y + radius)}`;
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
