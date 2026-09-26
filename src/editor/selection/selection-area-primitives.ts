import {
  pressureCapsuleSegmentMargin,
  type PressureCapsuleEndpoints,
} from "../../domain/geometry/pressure-capsule-selection";
import { pointInPolygonInclusive, segmentInsidePolygon } from "./selection-polygon";
import {
  boundsFromPoints,
  boundsIntersect,
  segmentDistanceSquared,
  segmentsIntersect,
  type Bounds,
} from "../../domain/geometry/public";
import { hasInteriorLassoBoundary, hasOddLassoBoundary } from "./lasso-interior-boundary";
import type { PointV1 } from "../../domain/schema/public";

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
  polygon: readonly PointV1[],
): Generator<number | void, boolean> {
  if (pointInPolygonInclusive(capsule.start, polygon)) return true;
  for (let index = 0; index < polygon.length; index += 1) {
    if (withinCapsuleDistance(capsule, polygon[index]!, polygon[(index + 1) % polygon.length]!))
      return true;
    if (index % 32 === 31) yield 32;
  }
  return false;
}

function* capsuleEnclosedByPolygon(
  capsule: Extract<VisibleSelectionPrimitive, { kind: "capsule" }>,
  polygon: readonly PointV1[],
): Generator<number | void, boolean> {
  if (capsule.radius > 0 && !pointInPolygonInclusive(capsule.start, polygon, false)) return false;
  if (!(yield* segmentInsidePolygon(capsule.start, capsule.end, polygon))) return false;
  if (capsule.radius === 0) return true;
  const requiredDistance = squared(capsule.radius);
  return !(yield* hasOddLassoBoundary(
    polygon,
    (edgeStart, edgeEnd) =>
      segmentDistanceSquared(capsule.start, capsule.end, edgeStart, edgeEnd, EPSILON) + EPSILON <
      requiredDistance,
  ));
}

function* pressureCapsuleTouchesPolygon(
  capsule: PressureCapsuleEndpoints,
  polygon: readonly PointV1[],
): Generator<number | void, boolean> {
  if (pointInPolygonInclusive(capsule.start.center, polygon)) return true;
  for (let index = 0; index < polygon.length; index += 1) {
    if (
      pressureCapsuleSegmentMargin(
        capsule,
        polygon[index]!,
        polygon[(index + 1) % polygon.length]!,
      ) <= EPSILON
    ) {
      return true;
    }
    if (index % 32 === 31) yield 32;
  }
  return false;
}

function* pressureCapsuleEnclosedByPolygon(
  capsule: PressureCapsuleEndpoints,
  polygon: readonly PointV1[],
): Generator<number | void, boolean> {
  if (!pointInPolygonInclusive(capsule.start.center, polygon, false)) return false;
  return !(yield* hasOddLassoBoundary(
    polygon,
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
  right: readonly PointV1[],
): Generator<number | void, boolean> {
  const firstLeft = left[0];
  const firstRight = right[0];
  if (firstLeft === undefined || firstRight === undefined) return false;
  // Without a boundary crossing, each connected polygon boundary stays in one
  // even-odd region. One representative vertex from each boundary suffices.
  if (pointInPolygonInclusive(firstLeft, right) || pointInPolygonInclusive(firstRight, left))
    return true;
  yield left.length + right.length;
  return yield* polygonEdgesTouch(left, right);
}

function* polygonEnclosedByPolygon(
  inner: readonly PointV1[],
  outer: readonly PointV1[],
): Generator<number | void, boolean> {
  for (const point of inner) {
    if (!pointInPolygonInclusive(point, outer)) return false;
    yield outer.length;
  }
  for (let index = 0; index < inner.length; index += 1) {
    if (!(yield* segmentInsidePolygon(inner[index]!, inner[(index + 1) % inner.length]!, outer))) {
      return false;
    }
  }
  return !(yield* hasInteriorLassoBoundary(inner, outer, pointInPolygonInclusive));
}

function* polygonEdgesTouch(
  left: readonly PointV1[],
  right: readonly PointV1[],
): Generator<number | void, boolean> {
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const leftStart = left[leftIndex]!;
    const leftEnd = left[(leftIndex + 1) % left.length]!;
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      if (
        segmentsIntersect(
          leftStart,
          leftEnd,
          right[rightIndex]!,
          right[(rightIndex + 1) % right.length]!,
          EPSILON,
        )
      ) {
        return true;
      }
    }
    yield right.length;
  }
  return false;
}

function squared(value: number): number {
  return value * value;
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
    return yield* pressureCapsuleTouchesPolygon(primitive.capsule, area.points);
  return primitive.kind === "capsule"
    ? yield* capsuleTouchesPolygon(primitive, area.points)
    : yield* polygonsTouch(primitive.points, area.points);
}

export function* primitiveEnclosedByAreaSteps(
  area: AreaPolygon,
  primitive: VisibleSelectionPrimitive,
): Generator<number | void, boolean> {
  if (!boundsContain(area.bounds, primitiveBounds(primitive))) return false;
  if (area.kind === "rectangle") return true;
  if (primitive.kind === "pressure-capsule")
    return yield* pressureCapsuleEnclosedByPolygon(primitive.capsule, area.points);
  return primitive.kind === "capsule"
    ? yield* capsuleEnclosedByPolygon(primitive, area.points)
    : yield* polygonEnclosedByPolygon(primitive.points, area.points);
}
