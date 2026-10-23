import type { ArrangeAction } from "../../../domain/commands/arrange";
import type { PreparedPressureGeometryPort } from "../../../domain/geometry/pressure/prepared-pressure-geometry";
import type { InkElementV1, PointV1 } from "../../../domain/schema/public";
import type { InputPoint, PointerSample } from "../../../editor/input/index";
import {
  elementContainsPoint,
  selectionOverlayContainsPoint,
  type SelectionFrameSession,
  type SelectedElementGeometry,
} from "../../../editor/selection/public";
import type { ElementSceneStore } from "./scene-store";

export function selectedElements(
  store: ElementSceneStore,
  selection: ReadonlySet<string>,
): InkElementV1[] {
  const elements: InkElementV1[] = [];
  for (const id of selection) {
    const element = store.get(id)?.element;
    if (element !== undefined) elements.push(element);
  }
  return elements;
}

export function visibleSelectionCenter(
  store: ElementSceneStore,
  selection: ReadonlySet<string>,
): PointV1 | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const id of selection) {
    const bounds = store.get(id)?.bounds;
    if (bounds === undefined) continue;
    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
  }
  return Number.isFinite(minX) ? { x: (minX + maxX) / 2, y: (minY + maxY) / 2 } : null;
}

export function canArrangeSelection(
  store: ElementSceneStore,
  selection: ReadonlySet<string>,
  action: ArrangeAction,
): boolean {
  return arrangeSelectionAvailability(store, selection)[action];
}

export function arrangeSelectionAvailability(
  store: ElementSceneStore,
  selection: ReadonlySet<string>,
): Readonly<Record<ArrangeAction, boolean>> {
  let canMoveForward = false;
  let canMoveBackward = false;
  const selectedBands = {
    highlight: { count: 0, minRank: Number.POSITIVE_INFINITY, maxRank: -1 },
    content: { count: 0, minRank: Number.POSITIVE_INFINITY, maxRank: -1 },
  };
  for (const id of selection) {
    const record = store.get(id);
    if (record === undefined) continue;
    const selected = selectedBands[record.band];
    selected.count += 1;
    selected.minRank = Math.min(selected.minRank, record.rank);
    selected.maxRank = Math.max(selected.maxRank, record.rank);
  }
  for (const band of ["highlight", "content"] as const) {
    const selected = selectedBands[band];
    if (selected.count === 0) continue;
    if (selected.minRank + selected.count < store.bandSize(band)) canMoveForward = true;
    if (selected.maxRank + 1 > selected.count) canMoveBackward = true;
  }
  return {
    "bring-forward": canMoveForward,
    "bring-to-front": canMoveForward,
    "send-backward": canMoveBackward,
    "send-to-back": canMoveBackward,
  };
}

export function selectionTargetAt(
  store: ElementSceneStore,
  selection: ReadonlySet<string>,
  point: InputPoint,
  pointerType: PointerSample["pointerType"],
  zoom: number,
  selectionContext?:
    | SelectionFrameSession
    | {
        readonly frames?: SelectionFrameSession;
        readonly geometry: () => readonly SelectedElementGeometry[];
      },
): { readonly elementId: string; readonly isSelected: boolean } | undefined {
  const selectionFrames =
    selectionContext !== undefined && "current" in selectionContext
      ? selectionContext
      : selectionContext?.frames;
  const selected =
    selectionContext !== undefined && "geometry" in selectionContext
      ? selectionContext.geometry()
      : selectedGeometry(store, selection);
  if (selectionOverlayContainsPoint(selected, point, selectionFrames?.current(selected) ?? null)) {
    return { elementId: selected[0]!.element.id, isSelected: true };
  }
  const elementId = store.hit(point, pointerType, zoom);
  return elementId === null ? undefined : { elementId, isSelected: selection.has(elementId) };
}

function selectedGeometry(
  store: ElementSceneStore,
  selection: ReadonlySet<string>,
): SelectedElementGeometry[] {
  const selected: SelectedElementGeometry[] = [];
  for (const id of selection) {
    const record = store.get(id);
    if (record !== undefined) selected.push({ bounds: record.bounds, element: record.element });
  }
  return selected;
}

/** Selected overlays and their painted singleton never query unrelated document elements. */
export function selectedTargetAt(
  selected: readonly SelectedElementGeometry[],
  point: InputPoint,
  frame: ReturnType<SelectionFrameSession["current"]>,
  context: {
    readonly tolerance: number;
    readonly preparePressure?: (id: string) => PreparedPressureGeometryPort | undefined;
  },
): { readonly elementId: string; readonly isSelected: true } | undefined {
  const first = selected[0];
  if (first === undefined) return undefined;
  if (selectionOverlayContainsPoint(selected, point, frame)) {
    return { elementId: first.element.id, isSelected: true };
  }
  const bounds = first.bounds;
  const { tolerance } = context;
  if (
    selected.length === 1 &&
    point.x >= bounds.minX - tolerance &&
    point.x <= bounds.maxX + tolerance &&
    point.y >= bounds.minY - tolerance &&
    point.y <= bounds.maxY + tolerance &&
    elementContainsPoint(
      first.element,
      point,
      tolerance,
      first.element.kind === "stroke" && first.element.style.pressureEnabled
        ? context.preparePressure?.(first.element.id)
        : undefined,
    )
  ) {
    return { elementId: first.element.id, isSelected: true };
  }
  return undefined;
}
