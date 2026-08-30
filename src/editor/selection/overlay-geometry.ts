import {
  calculateElementBounds,
  canonicalPoint,
  pointInPolygon,
  rotatePointClockwise,
} from "../../domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../domain/schema/public";

import type { SelectedElementGeometry, SelectionHandle } from "./handles";
import { layoutSelectionHandles, selectionBounds } from "./handles";
import type { SelectionPreviewTransform } from "./handle-types";

export type SelectionOutline =
  | {
      readonly bend: PointV1 | null;
      readonly end: PointV1;
      readonly kind: "linear";
      readonly start: PointV1;
    }
  | { readonly kind: "polygon"; readonly points: readonly PointV1[] };

interface SelectionOverlayGeometry {
  readonly handles: readonly SelectionHandle[];
  readonly outline: SelectionOutline;
}

export function selectionOverlayGeometry(
  selected: readonly SelectedElementGeometry[],
  zoom: number,
  transform: SelectionPreviewTransform | null = null,
): SelectionOverlayGeometry | null {
  if (selected.length === 0) return null;
  const outline = selectionOutline(selected);
  const handles = layoutSelectionHandles(selected, { zoom });
  if (outline === null) return null;
  if (transform === null) return { handles, outline };
  return {
    handles: handles.map((handle) => ({
      ...handle,
      point: transformSelectionPoint(handle.point, transform),
    })),
    outline: transformOutline(outline, transform),
  };
}

export function selectionOverlayContainsPoint(
  selected: readonly SelectedElementGeometry[],
  point: PointV1,
): boolean {
  const outline = selectionOutline(selected);
  return outline?.kind === "polygon" && pointInPolygon(point, outline.points);
}

export function transformSelectionPoint(
  point: PointV1,
  transform: SelectionPreviewTransform,
): PointV1 {
  if (transform.kind === "translate") {
    return canonicalPoint({ x: point.x + transform.delta.x, y: point.y + transform.delta.y });
  }
  if (transform.kind === "rotate") {
    return canonicalPoint(rotatePointClockwise(point, transform.center, transform.degrees));
  }
  const local = rotatePointClockwise(point, transform.anchor, -transform.rotation);
  const scaled = {
    x: transform.anchor.x + (local.x - transform.anchor.x) * transform.factors.x,
    y: transform.anchor.y + (local.y - transform.anchor.y) * transform.factors.y,
  };
  return canonicalPoint(rotatePointClockwise(scaled, transform.anchor, transform.rotation));
}

function selectionOutline(selected: readonly SelectedElementGeometry[]): SelectionOutline | null {
  if (selected.length === 1) return singleElementOutline(selected[0]!.element);
  const bounds = selectionBounds(selected);
  return bounds === null
    ? null
    : {
        kind: "polygon",
        points: rectanglePoints(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY),
      };
}

function singleElementOutline(element: InkElementV1): SelectionOutline {
  if (element.kind === "line" || element.kind === "arrow") {
    const rotate = (point: PointV1) => rotatePointClockwise(point, element.pivot, element.rotation);
    return {
      bend: element.bend === null ? null : rotate(element.bend),
      end: rotate(element.end),
      kind: "linear",
      start: rotate(element.start),
    };
  }
  const bounds = calculateElementBounds({ ...element, rotation: 0 });
  return {
    kind: "polygon",
    points: rectanglePoints(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY).map((point) =>
      rotatePointClockwise(point, element.pivot, element.rotation),
    ),
  };
}

function transformOutline(
  outline: SelectionOutline,
  transform: SelectionPreviewTransform,
): SelectionOutline {
  if (outline.kind === "polygon") {
    return {
      kind: "polygon",
      points: outline.points.map((point) => transformSelectionPoint(point, transform)),
    };
  }
  return {
    bend: outline.bend === null ? null : transformSelectionPoint(outline.bend, transform),
    end: transformSelectionPoint(outline.end, transform),
    kind: "linear",
    start: transformSelectionPoint(outline.start, transform),
  };
}

function rectanglePoints(minX: number, minY: number, maxX: number, maxY: number): PointV1[] {
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
}
