import {
  pressureCapsuleSegmentMargin,
  type PressureCapsuleEndpoints,
} from "../../../domain/geometry/pressure/pressure-capsule-selection";
import { pointInPolygonInclusive, segmentInsidePolygon } from "./selection-polygon";
import { indexedLassoEdges, indexedPointInPolygon } from "./lasso-edge-index";
import {
  boundsFromPoints,
  boundsIntersect,
  segmentDistanceSquared,
  segmentsIntersect,
  type Bounds,
} from "../../../domain/geometry/public";
import { hasInteriorLassoBoundary, hasOddLassoBoundary } from "./lasso-interior-boundary";
import type { PointV1 } from "../../../domain/schema/public";

export interface AreaPolygon {
  readonly kind?: "rectangle" | "lasso";
  readonly bounds: Bounds;
  readonly points: readonly PointV1[];
}

export type VisibleSelectionPrimitive =
  | {
      readonly kind: "capsule";
      readonly radius: number;
      readonly start: PointV1;
      readonly end: PointV1;
    }
  | { readonly kind: "pressure-capsule"; readonly capsule: PressureCapsuleEndpoints }
  | { readonly kind: "polygon"; readonly points: readonly PointV1[] };

const EPSILON = 1e-9;

function* capsuleTouchesPolygon(
  capsule: Extract<VisibleSelectionPrimitive, { kind: "capsule" }>,
  area: AreaPolygon,
): Generator<number | void, boolean> {
  if (yield* containsAreaPoint(capsule.start, area)) return true;
  return yield* touchesNearbyEdge(area, primitiveBounds(capsule), (start, end) =>
    withinCapsuleDistance(capsule, start, end),
  );
}

function* capsuleEnclosedByPolygon(
  capsule: Extract<VisibleSelectionPrimitive, { kind: "capsule" }>,
  area: AreaPolygon,
): Generator<number | void, boolean> {
  if (capsule.radius > 0 && !(yield* containsAreaPoint(capsule.start, area, false))) return false;
  if (!(yield* segmentInsidePolygon(capsule.start, capsule.end, area.points, area.bounds)))
    return false;
  if (capsule.radius === 0) return true;
  const requiredDistance = squared(capsule.radius);
  return !(yield* hasOddLassoBoundary(
    area.points,
    (edgeStart, edgeEnd) =>
      segmentDistanceSquared(capsule.start, capsule.end, edgeStart, edgeEnd, EPSILON) + EPSILON <
      requiredDistance,
  ));
}

function* pressureCapsuleTouchesPolygon(
  capsule: PressureCapsuleEndpoints,
  area: AreaPolygon,
): Generator<number | void, boolean> {
  if (yield* containsAreaPoint(capsule.start.center, area)) return true;
  return yield* touchesNearbyEdge(
    area,
    expandedBounds(primitiveBounds({ kind: "pressure-capsule", capsule })),
    (start, end) => pressureCapsuleSegmentMargin(capsule, start, end) <= EPSILON,
  );
}

function* touchesNearbyEdge(
  area: AreaPolygon,
  bounds: Bounds,
  touches: (start: PointV1, end: PointV1) => boolean,
): Generator<number | void, boolean> {
  const edges = yield* areaEdgesNear(area, bounds);
  for (let index = 0; index < edges.length; index += 1) {
    if (touches(edges[index]!.start, edges[index]!.end)) {
      yield (index % 32) + 1;
      return true;
    }
    if (index % 32 === 31) yield 32;
  }
  if (edges.length % 32 !== 0) yield edges.length % 32;
  return false;
}

function* pressureCapsuleEnclosedByPolygon(
  capsule: PressureCapsuleEndpoints,
  area: AreaPolygon,
): Generator<number | void, boolean> {
  if (!(yield* containsAreaPoint(capsule.start.center, area, false))) return false;
  return !(yield* hasOddLassoBoundary(
    area.points,
    (start, end) => pressureCapsuleSegmentMargin(capsule, start, end) < -EPSILON,
  ));
}

function withinCapsuleDistance(
  capsule: Extract<VisibleSelectionPrimitive, { kind: "capsule" }>,
  edgeStart: PointV1,
  edgeEnd: PointV1,
): boolean {
  return (
    segmentDistanceSquared(capsule.start, capsule.end, edgeStart, edgeEnd) <=
    squared(capsule.radius)
  );
}

function* polygonsTouch(
  left: readonly PointV1[],
  area: AreaPolygon,
): Generator<number | void, boolean> {
  const firstLeft = left[0];
  const firstRight = area.points[0];
  if (firstLeft === undefined || firstRight === undefined) return false;
  // Without a boundary crossing, each connected polygon boundary stays in one
  // even-odd region. One representative vertex from each boundary suffices.
  if (yield* containsAreaPoint(firstLeft, area)) return true;
  if (pointInPolygonInclusive(firstRight, left)) {
    yield left.length;
    return true;
  }
  yield left.length;
  return yield* polygonEdgesTouch(left, area);
}

function* polygonEnclosedByPolygon(
  inner: readonly PointV1[],
  area: AreaPolygon,
): Generator<number | void, boolean> {
  for (const point of inner) {
    if (!(yield* containsAreaPoint(point, area))) return false;
  }
  for (let index = 0; index < inner.length; index += 1) {
    if (
      !(yield* segmentInsidePolygon(
        inner[index]!,
        inner[(index + 1) % inner.length]!,
        area.points,
        area.bounds,
      ))
    ) {
      return false;
    }
  }
  return !(yield* hasInteriorLassoBoundary(inner, area.points, pointInPolygonInclusive));
}

function* polygonEdgesTouch(
  left: readonly PointV1[],
  area: AreaPolygon,
): Generator<number | void, boolean> {
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const leftStart = left[leftIndex]!;
    const leftEnd = left[(leftIndex + 1) % left.length]!;
    const edges = yield* areaEdgesNear(area, {
      minX: Math.min(leftStart.x, leftEnd.x) - EPSILON,
      maxX: Math.max(leftStart.x, leftEnd.x) + EPSILON,
      minY: Math.min(leftStart.y, leftEnd.y) - EPSILON,
      maxY: Math.max(leftStart.y, leftEnd.y) + EPSILON,
    });
    let checked = 0;
    for (let rightIndex = 0; rightIndex < edges.length; rightIndex += 1) {
      if (
        segmentsIntersect(
          leftStart,
          leftEnd,
          edges[rightIndex]!.start,
          edges[rightIndex]!.end,
          EPSILON,
        )
      ) {
        yield (checked % 32) + 1;
        return true;
      }
      checked += 1;
      if (checked % 32 === 0) yield 32;
    }
    if (checked % 32 !== 0) yield checked % 32;
  }
  return false;
}

function squared(value: number): number {
  return value * value;
}

function expandedBounds(bounds: Bounds): Bounds {
  const tolerance = Math.sqrt(EPSILON);
  return {
    minX: bounds.minX - tolerance,
    minY: bounds.minY - tolerance,
    maxX: bounds.maxX + tolerance,
    maxY: bounds.maxY + tolerance,
  };
}

function* containsAreaPoint(
  point: PointV1,
  area: AreaPolygon,
  includeBoundary = true,
): Generator<number, boolean> {
  return area.kind === "lasso"
    ? yield* indexedPointInPolygon(point, area.points, area.bounds, includeBoundary)
    : pointInPolygonInclusive(point, area.points, includeBoundary);
}

function* areaEdgesNear(
  area: AreaPolygon,
  bounds: Bounds,
): Generator<number, readonly { readonly start: PointV1; readonly end: PointV1 }[]> {
  if (area.kind === "lasso") return yield* indexedLassoEdges(area.points, area.bounds, bounds);
  return area.points.map((start, index) => ({
    start,
    end: area.points[(index + 1) % area.points.length]!,
  }));
}

function primitiveBounds(primitive: VisibleSelectionPrimitive): Bounds {
  if (primitive.kind === "polygon") return boundsFromPoints(primitive.points);
  if (primitive.kind === "pressure-capsule") {
    const { start, end } = primitive.capsule;
    return {
      minX: Math.min(start.center.x - start.radius, end.center.x - end.radius),
      minY: Math.min(start.center.y - start.radius, end.center.y - end.radius),
      maxX: Math.max(start.center.x + start.radius, end.center.x + end.radius),
      maxY: Math.max(start.center.y + start.radius, end.center.y + end.radius),
    };
  }
  return {
    minX: Math.min(primitive.start.x, primitive.end.x) - primitive.radius,
    minY: Math.min(primitive.start.y, primitive.end.y) - primitive.radius,
    maxX: Math.max(primitive.start.x, primitive.end.x) + primitive.radius,
    maxY: Math.max(primitive.start.y, primitive.end.y) + primitive.radius,
  };
}

function boundsContain(outer: Bounds, inner: Bounds): boolean {
  return (
    inner.minX >= outer.minX - EPSILON &&
    inner.minY >= outer.minY - EPSILON &&
    inner.maxX <= outer.maxX + EPSILON &&
    inner.maxY <= outer.maxY + EPSILON
  );
}

export function* primitiveTouchesAreaSteps(
  area: AreaPolygon,
  primitive: VisibleSelectionPrimitive,
): Generator<number | void, boolean> {
  if (!boundsIntersect(area.bounds, primitiveBounds(primitive))) return false;
  if (primitive.kind === "pressure-capsule")
    return yield* pressureCapsuleTouchesPolygon(primitive.capsule, area);
  return primitive.kind === "capsule"
    ? yield* capsuleTouchesPolygon(primitive, area)
    : yield* polygonsTouch(primitive.points, area);
}

export function* primitiveEnclosedByAreaSteps(
  area: AreaPolygon,
  primitive: VisibleSelectionPrimitive,
): Generator<number | void, boolean> {
  if (!boundsContain(area.bounds, primitiveBounds(primitive))) return false;
  if (area.kind === "rectangle") return true;
  if (primitive.kind === "pressure-capsule")
    return yield* pressureCapsuleEnclosedByPolygon(primitive.capsule, area);
  return primitive.kind === "capsule"
    ? yield* capsuleEnclosedByPolygon(primitive, area)
    : yield* polygonEnclosedByPolygon(primitive.points, area);
}
