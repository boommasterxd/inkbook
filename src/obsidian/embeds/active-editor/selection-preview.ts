import { calculateElementBounds } from "../../../domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../../domain/schema/public";
import type { ToolDefaultsV1 } from "../../../domain/settings/types";
import type { ElementStore } from "../../../domain/store/public";
import type { GesturePreview, GesturePreviewStart } from "../../../editor/gestures/public";
import {
  connectedSelectionTransformPreview,
  createLassoSelectionArea,
  createRectangleSelectionArea,
  MAX_LASSO_SELECTION_POINTS,
  moveSelection,
  selectBySelectionAreaQuery,
  type SelectedElementGeometry,
  type ConnectedSelectionPreview,
  type SelectionArea,
  type SelectionPreviewTransform,
} from "../../../editor/selection/public";

import type { ActiveEditorHistory } from "./history";
import type { PreparedElementHistory } from "./prepared-element-history";
import type { ElementSceneStore } from "./scene-store";
import { selectionOverlayFill, selectionOverlayPath } from "./selection-overlay-path";

interface SelectionPreviewRenderer {
  clearElementPreviews?(): void;
  clearPreviewTransforms(): void;
  setElementPreviews?(elements: readonly InkElementV1[], version: number): void;
  setOverlayPath(d: string | null): void;
  setSelectionOverlayPath?(d: string | null, fill?: "accent" | "none"): void;
  setPreviewTransform(ids: readonly string[], transform: string | null, version: number): void;
  suppressMotionForNextDelta(ids: readonly string[]): void;
}

export interface SelectionEdgeDragPort {
  begin(onViewportChanged?: () => void): void;
  finish(): void;
  update(screenPointer: PointV1): void;
}

export interface SelectionPreviewOptions {
  readonly history: ActiveEditorHistory;
  readonly pageToScreen: (point: PointV1) => PointV1;
  readonly pageToViewport?: (point: PointV1) => PointV1;
  readonly viewportToPage?: (point: PointV1) => PointV1;
  readonly preparedHistory: PreparedElementHistory;
  readonly renderer: SelectionPreviewRenderer;
  readonly sceneStore: ElementSceneStore;
  readonly selectionEdgeDrag?: SelectionEdgeDragPort;
  readonly selection: () => ReadonlySet<string>;
  readonly selectionDefaults?: ToolDefaultsV1["select"];
  readonly setSelection: (selection: ReadonlySet<string>) => void;
  readonly start: GesturePreviewStart;
  readonly store: ElementStore;
  readonly zoom?: () => number;
}

export class LassoPreview implements GesturePreview {
  readonly #options: SelectionPreviewOptions;
  readonly #selectionDefaults: ToolDefaultsV1["select"];
  #current: PointV1;
  #finished = false;
  #points: PointV1[];

  public constructor(options: SelectionPreviewOptions) {
    this.#options = options;
    this.#selectionDefaults = options.selectionDefaults ?? {
      area: "rectangle",
      inclusion: "touched",
    };
    this.#current = options.start.pointer;
    this.#points = [options.start.pointer];
    this.#render();
  }

  public commit(): boolean {
    this.#assertActive();
    this.#finished = true;
    const previous = this.#options.selection();
    const area = this.#selectionArea();
    const next =
      area === null
        ? previous
        : selectBySelectionAreaQuery(
            previous,
            area,
            this.#selectionDefaults.inclusion,
            this.#options.start.additive,
            (bounds, sink) =>
              this.#options.sceneStore.query(bounds, {
                add: (id) => {
                  const record = this.#options.store.get(id);
                  if (record !== undefined) {
                    sink.add(id, record.bounds, record.element as InkElementV1);
                  }
                },
              }),
          );
    this.#options.renderer.setOverlayPath(null);
    if (next !== previous) this.#options.setSelection(next);
    return next !== previous;
  }

  public revert(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#options.renderer.setOverlayPath(null);
  }

  public update(pointer: GesturePreviewStart["pointer"]): void {
    this.#assertActive();
    this.#current = pointer;
    if (this.#selectionDefaults.area === "lasso") this.#appendLassoPoint(pointer);
    this.#render();
  }

  #assertActive(): void {
    if (this.#finished) throw new Error("A completed lasso preview cannot be updated.");
  }

  #render(): void {
    const points =
      this.#selectionDefaults.area === "rectangle"
        ? createRectangleSelectionArea(this.#options.start.pointer, this.#current).points
        : this.#points;
    this.#options.renderer.setOverlayPath(screenSelectionPath(points, this.#options.pageToScreen));
  }

  #selectionArea(): SelectionArea | null {
    if (this.#selectionDefaults.area === "rectangle") {
      return createRectangleSelectionArea(this.#options.start.pointer, this.#current);
    }
    try {
      return createLassoSelectionArea(this.#points);
    } catch (error: unknown) {
      if (error instanceof RangeError) return null;
      throw error;
    }
  }

  #appendLassoPoint(point: PointV1): void {
    const previous = this.#points[this.#points.length - 1];
    if (previous !== undefined && pointDistance(previous, point) * this.#selectionZoom() < 1.5) {
      return;
    }
    if (this.#points.length === MAX_LASSO_SELECTION_POINTS) {
      this.#points = compactLassoPoints(this.#points);
    }
    this.#points.push(point);
  }

  #selectionZoom(): number {
    const zoom = this.#options.zoom?.();
    return zoom !== undefined && Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  }
}

function screenSelectionPath(
  points: readonly PointV1[],
  pageToScreen: (point: PointV1) => PointV1,
): string {
  const [first, ...rest] = points.map(pageToScreen);
  if (first === undefined) return "";
  const path = [`M ${String(first.x)} ${String(first.y)}`];
  for (const point of rest) path.push(`L ${String(point.x)} ${String(point.y)}`);
  if (points.length >= 3) path.push("Z");
  return path.join(" ");
}

function compactLassoPoints(points: readonly PointV1[]): PointV1[] {
  const compacted = [points[0]!];
  for (let index = 2; index < points.length - 1; index += 2) compacted.push(points[index]!);
  compacted.push(points[points.length - 1]!);
  return compacted;
}

function pointDistance(left: PointV1, right: PointV1): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

export class MovePreview implements GesturePreview {
  readonly #connectedTargetIds: readonly string[];
  readonly #elements: readonly InkElementV1[];
  readonly #ids: readonly string[];
  readonly #options: SelectionPreviewOptions;
  readonly #selectedIds: ReadonlySet<string>;
  readonly #selectedGeometry: readonly SelectedElementGeometry[];
  #current = { x: 0, y: 0 };
  #currentViewport: PointV1 | undefined;
  #finished = false;
  #lastPointer: GesturePreviewStart["pointer"];
  #version = 0;

  public constructor(options: SelectionPreviewOptions) {
    this.#options = options;
    this.#selectedIds = options.selection();
    const elements: InkElementV1[] = [];
    const selectedGeometry: SelectedElementGeometry[] = [];
    for (const id of this.#selectedIds) {
      const record = options.store.get(id);
      if (record !== undefined) {
        const element = record.element as InkElementV1;
        elements.push(element);
        selectedGeometry.push({ bounds: record.bounds, element });
      }
    }
    this.#elements = elements;
    this.#selectedGeometry = selectedGeometry;
    this.#ids = this.#elements.map(({ id }) => id);
    this.#connectedTargetIds = this.#ids.filter((id) => {
      let connected = false;
      options.store.visitDependents(id, () => {
        connected = true;
      });
      return connected;
    });
    this.#lastPointer = options.start.pointer;
    this.#currentViewport = (options.pageToViewport ?? options.pageToScreen)(options.start.pointer);
    options.selectionEdgeDrag?.begin(() => this.#refreshAfterViewportChange());
  }

  public commit(): boolean {
    this.#assertActive();
    this.#finished = true;
    let committed = false;
    try {
      if (this.#current.x !== 0 || this.#current.y !== 0) {
        committed = this.#options.preparedHistory.commitMove(this.#elements, this.#current);
        if (!committed) {
          const plan = this.#options.store.planReplacements(
            moveSelection(this.#elements, this.#current),
          );
          if (plan !== null) {
            this.#options.renderer.suppressMotionForNextDelta(this.#ids);
            committed = this.#options.history.replace(this.#elements, plan.replacements);
          }
        }
      }
    } catch (error: unknown) {
      if (!(error instanceof RangeError)) throw error;
    } finally {
      this.#options.renderer.clearPreviewTransforms();
      this.#options.renderer.clearElementPreviews?.();
      this.#renderSelectionOverlay(committed ? this.#translationTransform() : null);
      this.#options.selectionEdgeDrag?.finish();
    }
    return committed;
  }

  public revert(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#options.renderer.clearPreviewTransforms();
    this.#options.renderer.clearElementPreviews?.();
    this.#renderSelectionOverlay(null);
    this.#options.selectionEdgeDrag?.finish();
  }

  public update(pointer: GesturePreviewStart["pointer"]): void {
    this.#assertActive();
    const viewport = (this.#options.pageToViewport ?? this.#options.pageToScreen)(pointer);
    this.#currentViewport = viewport;
    const current = this.#projectViewportPointer(pointer, viewport);
    this.#lastPointer = current;
    this.#renderUpdate(current);
    this.#options.selectionEdgeDrag?.update(viewport);
  }

  #renderUpdate(pointer: GesturePreviewStart["pointer"]): void {
    this.#current = {
      x: pointer.x - this.#options.start.pointer.x,
      y: pointer.y - this.#options.start.pointer.y,
    };
    this.#version += 1;
    const transform = this.#translationTransform();
    const connected = this.#renderConnectedElements(transform);
    this.#options.renderer.setPreviewTransform(
      this.#ids.filter((id) => !connected.selectedPreviewIds.has(id)),
      `translate(${String(this.#current.x)} ${String(this.#current.y)})`,
      this.#version,
    );
    this.#renderSelectionOverlay(transform, connected);
  }

  #projectViewportPointer(
    pointer: GesturePreviewStart["pointer"],
    viewport: PointV1 | undefined,
  ): GesturePreviewStart["pointer"] {
    const page = viewport === undefined ? undefined : this.#options.viewportToPage?.(viewport);
    return page === undefined ? pointer : { ...pointer, ...page };
  }

  #refreshAfterViewportChange(): void {
    if (this.#finished || this.#currentViewport === undefined) return;
    const pointer = this.#projectViewportPointer(this.#lastPointer, this.#currentViewport);
    this.#lastPointer = pointer;
    this.#renderUpdate(pointer);
  }

  #assertActive(): void {
    if (this.#finished) throw new Error("A completed move preview cannot be updated.");
  }

  #renderConnectedElements(transform: SelectionPreviewTransform): ConnectedSelectionPreview {
    if (this.#options.renderer.setElementPreviews === undefined) {
      return { elements: [], selectedPreviewIds: new Set() };
    }
    try {
      const connected = connectedSelectionTransformPreview(
        this.#options.store,
        this.#elements,
        this.#selectedIds,
        transform,
        this.#connectedTargetIds,
      );
      this.#options.renderer.setElementPreviews(connected.elements, this.#version);
      return connected;
    } catch (error: unknown) {
      if (!(error instanceof RangeError)) throw error;
      this.#options.renderer.setElementPreviews([], this.#version);
      return { elements: [], selectedPreviewIds: new Set() };
    }
  }

  #renderSelectionOverlay(
    transform: SelectionPreviewTransform | null,
    connected: ConnectedSelectionPreview = { elements: [], selectedPreviewIds: new Set() },
  ): void {
    const exact =
      this.#selectedGeometry.length === 1 &&
      connected.selectedPreviewIds.has(this.#selectedGeometry[0]!.element.id)
        ? this.#connectedSelectionGeometry(connected.elements)
        : null;
    this.#options.renderer.setSelectionOverlayPath?.(
      selectionOverlayPath(exact ?? this.#selectedGeometry, {
        pageToScreen: this.#options.pageToScreen,
        transform: exact === null ? transform : null,
        zoom: this.#selectionZoom(),
      }),
      selectionOverlayFill(exact ?? this.#selectedGeometry),
    );
  }

  #connectedSelectionGeometry(
    elements: readonly InkElementV1[],
  ): readonly SelectedElementGeometry[] {
    const id = this.#selectedGeometry[0]!.element.id;
    const element = elements.find((candidate) => candidate.id === id);
    return element === undefined
      ? this.#selectedGeometry
      : [{ bounds: calculateElementBounds(element), element }];
  }

  #selectionZoom(): number {
    const configured = this.#options.zoom?.();
    if (configured !== undefined && Number.isFinite(configured) && configured > 0)
      return configured;
    const origin = this.#options.pageToScreen({ x: 0, y: 0 });
    const unit = this.#options.pageToScreen({ x: 1, y: 0 });
    const inferred = Math.hypot(unit.x - origin.x, unit.y - origin.y);
    return Number.isFinite(inferred) && inferred > 0 ? inferred : 1;
  }

  #translationTransform(): SelectionPreviewTransform {
    return { delta: this.#current, kind: "translate" };
  }
}
