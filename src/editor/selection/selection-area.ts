import type { PreparedPressureGeometryPort } from "../../domain/geometry/prepared-pressure-geometry";
import { assertFinitePoint, boundsFromPoints, boundsIntersect } from "../../domain/geometry/public";
import type { Bounds } from "../../domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../domain/schema/public";

import { visibleElementPrimitiveSteps } from "./element-selection-geometry";
import {
  primitiveEnclosedByAreaSteps,
  primitiveTouchesAreaSteps,
} from "./selection-area-primitives";

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

/** Yields after each bounded primitive so hosts can cancel or schedule large queries. */
export function* elementMatchesSelectionAreaSteps(
  area: SelectionArea,
  element: InkElementV1,
  inclusion: SelectionAreaInclusion,
  candidateBounds: Bounds,
  prepared?: PreparedPressureGeometryPort,
): Generator<number | void, boolean> {
  if (!boundsIntersect(area.bounds, candidateBounds) || !hasPositiveArea(area)) return false;
  if (element.kind === "stroke") {
    if (element.style.opacity <= 0) return false;
    const { minX, minY, maxX, maxY } = candidateBounds;
    const box = {
      kind: "polygon" as const,
      points: [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
      ],
    };
    if (area.kind === "rectangle") {
      if (yield* primitiveEnclosedByAreaSteps(area, box)) return true;
    } else if (boundsAvoidLassoBoundary(area, candidateBounds)) {
      const corner = box.points[0]!;
      return yield* primitiveTouchesAreaSteps(area, {
        kind: "capsule",
        start: corner,
        end: corner,
        radius: 0,
      });
    }
  }
  let visible = false;
  for (const primitive of visibleElementPrimitiveSteps(element, {
    bounds: area.bounds,
    prepared,
  })) {
    if (primitive === undefined || typeof primitive === "number") {
      yield primitive;
      continue;
    }
    visible = true;
    const matches =
      inclusion === "touched"
        ? yield* primitiveTouchesAreaSteps(area, primitive)
        : yield* primitiveEnclosedByAreaSteps(area, primitive);
    if (inclusion === "touched" && matches) return true;
    if (inclusion === "fully-enclosed" && !matches) return false;
    // One primitive is not a full index/geometry batch; nested work yields separately.
    yield area.kind === "rectangle" ? 1 : 1 + Math.ceil(area.points.length / 32);
  }
  return visible && inclusion === "fully-enclosed";
}

/** Boundary-free boxes cannot hide an excluded even-odd lasso region. */
function boundsAvoidLassoBoundary(area: SelectionArea, bounds: Bounds): boolean {
  for (let index = 0; index < area.points.length; index += 1) {
    const start = area.points[index]!;
    const end = area.points[(index + 1) % area.points.length]!;
    if (
      boundsIntersect(bounds, {
        minX: Math.min(start.x, end.x),
        minY: Math.min(start.y, end.y),
        maxX: Math.max(start.x, end.x),
        maxY: Math.max(start.y, end.y),
      })
    )
      return false;
  }
  return true;
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
