import type { ArrangeAction } from "../../../domain/commands/arrange";
import type { InkElementV1, PointV1 } from "../../../domain/schema/public";
import type { InputPoint, PointerSample } from "../../../editor/input/index";
import {
  selectionOverlayContainsPoint,
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
  for (const band of ["highlight", "content"] as const) {
    let selectedSeen = false;
    let unselectedSeen = false;
    for (const id of store.materializeBandOrder(band)) {
      if (selection.has(id)) {
        selectedSeen = true;
        if (unselectedSeen) canMoveBackward = true;
      } else {
        unselectedSeen = true;
        if (selectedSeen) canMoveForward = true;
      }
    }
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
): { readonly elementId: string; readonly isSelected: boolean } | undefined {
  const selected = selectedGeometry(store, selection);
  if (selectionOverlayContainsPoint(selected, point)) {
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
