import {
  assertFinitePoint,
  boundsFromPoints,
  boundsIntersect,
  calculateElementBounds,
} from "../../domain/geometry/public";
import type { Bounds } from "../../domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../domain/schema/public";

import { visitVisibleElementPrimitives } from "./element-selection-geometry";
import { primitiveEnclosedByArea, primitiveTouchesArea } from "./selection-area-primitives";

export type SelectionAreaInclusion = "fully-enclosed" | "touched";

export type SelectionArea =
  | {
      readonly kind: "rectangle";
      readonly bounds: Readonly<Bounds>;
      readonly points: readonly [PointV1, PointV1, PointV1, PointV1];
    }
  | {
      readonly kind: "lasso";
      readonly bounds: Readonly<Bounds>;
      readonly points: readonly PointV1[];
    };

export const MAX_LASSO_SELECTION_POINTS = 512;

export function createRectangleSelectionArea(start: PointV1, end: PointV1): SelectionArea {
  assertSelectionAreaPoint(start);
  assertSelectionAreaPoint(end);
  const bounds = Object.freeze(boundsFromPoints([start, end]));
  const points: readonly [PointV1, PointV1, PointV1, PointV1] = Object.freeze([
    frozenPoint(bounds.minX, bounds.minY),
    frozenPoint(bounds.maxX, bounds.minY),
    frozenPoint(bounds.maxX, bounds.maxY),
    frozenPoint(bounds.minX, bounds.maxY),
  ]);
  return Object.freeze({ kind: "rectangle", bounds, points });
}

export function createLassoSelectionArea(input: readonly PointV1[]): SelectionArea {
  if (input.length > MAX_LASSO_SELECTION_POINTS) {
    throw new RangeError(
      `A lasso selection supports at most ${String(MAX_LASSO_SELECTION_POINTS)} points.`,
    );
  }
  const points = input.map((point) => {
    assertSelectionAreaPoint(point);
    return frozenPoint(point.x, point.y);
  });
  if (samePoint(points[0], points[points.length - 1])) points.pop();
  if (points.length < 3 || !hasNonCollinearPoints(points)) {
    throw new RangeError("A lasso selection requires at least three non-collinear points.");
  }
  const frozenPoints = Object.freeze(points);
  return Object.freeze({
    kind: "lasso",
    bounds: Object.freeze(boundsFromPoints(frozenPoints)),
    points: frozenPoints,
  });
}

export function selectionAreaBounds(area: SelectionArea): Readonly<Bounds> {
  return area.bounds;
}

export function elementMatchesSelectionArea(
  area: SelectionArea,
  element: InkElementV1,
  inclusion: SelectionAreaInclusion,
  candidateBounds: Bounds = calculateElementBounds(element),
): boolean {
  if (!boundsIntersect(area.bounds, candidateBounds) || !hasPositiveArea(area)) {
    return false;
  }
  let visible = false;
  let matches = inclusion === "fully-enclosed";
  const completed = visitVisibleElementPrimitives(element, (primitive) => {
    visible = true;
    const primitiveMatches =
      inclusion === "touched"
        ? primitiveTouchesArea(area, primitive)
        : primitiveEnclosedByArea(area, primitive);
    if (inclusion === "touched" && primitiveMatches) {
      matches = true;
      return false;
    }
    if (inclusion === "fully-enclosed" && !primitiveMatches) {
      matches = false;
      return false;
    }
    return true;
  });
  return visible && (completed || inclusion === "touched") && matches;
}

function hasPositiveArea(area: SelectionArea): boolean {
  return (
    area.kind === "lasso" ||
    (area.bounds.maxX > area.bounds.minX && area.bounds.maxY > area.bounds.minY)
  );
}

function assertSelectionAreaPoint(point: PointV1): void {
  assertFinitePoint(point, "Selection-area points must contain finite coordinates.");
}

function hasNonCollinearPoints(points: readonly PointV1[]): boolean {
  const start = points[0];
  if (start === undefined) return false;
  const secondIndex = points.findIndex((point) => !samePoint(start, point));
  const second = points[secondIndex];
  if (second === undefined) return false;
  for (let index = secondIndex + 1; index < points.length; index += 1) {
    const point = points[index]!;
    const cross =
      (second.x - start.x) * (point.y - start.y) - (second.y - start.y) * (point.x - start.x);
    if (Math.abs(cross) > 1e-9) return true;
  }
  return false;
}

function frozenPoint(x: number, y: number): PointV1 {
  return Object.freeze({ x, y });
}

function samePoint(left: PointV1 | undefined, right: PointV1 | undefined): boolean {
  return left !== undefined && right !== undefined && left.x === right.x && left.y === right.y;
}
