import type { PreparedPressureGeometryPort } from "../../domain/geometry/prepared-pressure-geometry";
import { pressureContourOutwardError } from "../../domain/geometry/pressure-contour-approximation";
import { pressureRadius } from "../../domain/geometry/pressure-radius";
import type { StrokeCenter } from "../../domain/geometry/stroke-path";
import { assertFinitePoint, boundsFromPoints, boundsIntersect } from "../../domain/geometry/public";
import type { Bounds } from "../../domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../domain/schema/public";

import { visibleElementPrimitiveSteps } from "./element-selection-geometry";
import type { PressurePaintQuery } from "./pressure-paint-additions";
import {
  primitiveEnclosedByAreaSteps,
  primitiveTouchesAreaSteps,
} from "./selection-area-primitives";
import {
  indexedLassoEdges,
  indexedPointInPolygon,
  registerImmutableLassoPoints,
} from "./lasso-edge-index";

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
  registerImmutableLassoPoints(frozenPoints);
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
    } else if (yield* weightedCheapPredicate(boundsAvoidLassoBoundary(area, candidateBounds))) {
      const corner = box.points[0]!;
      return yield* weightedCheapPredicate(indexedPointInPolygon(corner, area.points, area.bounds));
    }
  }
  let visible = false;
  for (const primitive of visibleElementPrimitiveSteps(
    element,
    selectionPaintQuery(area, inclusion, prepared),
  )) {
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

function selectionPaintQuery(
  area: SelectionArea,
  inclusion: SelectionAreaInclusion,
  prepared: PreparedPressureGeometryPort | undefined,
): PressurePaintQuery {
  return {
    bounds: area.bounds,
    prepared,
    ...(area.kind === "lasso" && inclusion === "touched"
      ? {
          additionsMayTouch: (centers: readonly StrokeCenter[], width: number) =>
            pressureAdditionsMayTouchArea(area, centers, width),
        }
      : {}),
  };
}

/** Outward addition triangles remain within this radius of the ideal capsule union. */
function* pressureAdditionsMayTouchArea(
  area: SelectionArea,
  centers: readonly StrokeCenter[],
  width: number,
): Generator<number | undefined, boolean> {
  const outward = pressureContourOutwardError(width);
  let checked = 0;
  for (let index = 0; index < Math.max(1, centers.length - 1); index += 1) {
    const start = centers[index]!;
    const end = centers[Math.min(index + 1, centers.length - 1)]!;
    const touches = primitiveTouchesAreaSteps(area, {
      kind: "pressure-capsule",
      capsule: {
        start: { center: start, radius: pressureRadius(start.pressure, width) + outward },
        end: { center: end, radius: pressureRadius(end.pressure, width) + outward },
      },
    });
    try {
      let step = touches.next();
      while (!step.done) {
        yield typeof step.value === "number" ? step.value : undefined;
        step = touches.next();
      }
      checked += 1;
      if (step.value) {
        yield checked % 32 || 32;
        return true;
      }
    } finally {
      touches.return(false);
    }
    if (checked % 32 === 0) yield 32;
  }
  if (checked % 32 !== 0) yield checked % 32;
  return false;
}

/** Boundary-free boxes cannot hide an excluded even-odd lasso region. */
function* boundsAvoidLassoBoundary(
  area: SelectionArea,
  bounds: Bounds,
): Generator<number, boolean> {
  const edges = yield* indexedLassoEdges(area.points, area.bounds, bounds);
  for (let index = 0; index < edges.length; index += 1) {
    if (edgeCrossesBounds(edges[index]!.start, edges[index]!.end, bounds)) {
      yield (index % 32) + 1;
      return false;
    }
    if (index % 32 === 31) yield 32;
  }
  if (edges.length % 32 !== 0) yield edges.length % 32;
  return true;
}

function edgeCrossesBounds(start: PointV1, end: PointV1, bounds: Bounds): boolean {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const tolerance = 1e-9 * (Math.abs(dx) + Math.abs(dy) + 1);
  let entry = 0;
  let exit = 1;
  for (const [origin, delta, low, high] of [
    [start.x, dx, bounds.minX - tolerance, bounds.maxX + tolerance],
    [start.y, dy, bounds.minY - tolerance, bounds.maxY + tolerance],
  ] as const) {
    if (delta === 0) {
      if (origin < low || origin > high) return false;
      continue;
    }
    const first = (low - origin) / delta;
    const last = (high - origin) / delta;
    entry = Math.max(entry, Math.min(first, last));
    exit = Math.min(exit, Math.max(first, last));
    if (entry > exit) return false;
  }
  return true;
}

/** Only the stroke-box shortcut treats each <=32 edge-visit checkpoint as cheap work. */
function* weightedCheapPredicate(steps: Generator<number, boolean>): Generator<number, boolean> {
  try {
    while (true) {
      const step = steps.next();
      if (step.done) return step.value;
      yield Math.max(1, Math.ceil(step.value / 32));
    }
  } finally {
    steps.return(false);
  }
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
