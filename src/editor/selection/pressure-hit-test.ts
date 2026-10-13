import { strokeLocalGeometry } from "../../domain/geometry/stroke-position";
import { pressureContourOutwardError } from "../../domain/geometry/pressure-contour-approximation";
import type { PreparedPressureGeometryPort } from "../../domain/geometry/prepared-pressure-geometry";
import { pointInPolygon, pointSegmentDistance } from "../../domain/geometry/primitives";
import { pressurePaintAdditionSteps } from "./pressure-paint-additions";
import { isStoredStroke } from "../../domain/elements/stroke-replacement-proof";
import { pressureCapsuleContainsPoint } from "../../domain/geometry/pressure-capsule-selection";
import { boundsFromPoints, type Bounds } from "../../domain/geometry/public";
import { pressureRadius } from "../../domain/geometry/pressure-radius";
import { transformedStrokeCenters, type StrokeCenter } from "../../domain/geometry/stroke-path";
import { simplifyStrokeCenters } from "../../domain/geometry/stroke-simplification";
import { selectionStrokeCenters } from "./stroke-selection-centers";
import type { PointV1, StrokeElementV1 } from "../../domain/schema/public";

interface PressureHitBlock {
  readonly bounds: Bounds;
  readonly firstBoundary: number;
  readonly lastBoundary: number;
}

interface PressureHitIndex {
  readonly width: number;
  readonly rotation: number;
  readonly pivotX: number;
  readonly pivotY: number;
  readonly centers: readonly StrokeCenter[];
  readonly blocks: readonly PressureHitBlock[];
}

const pressureHitIndexes = new WeakMap<object, PressureHitIndex>();

/** Cache compact centers and bounds; test only nearby swept nibs. */
export function pressureStrokeContainsPoint(
  stroke: StrokeElementV1,
  point: PointV1,
  tolerance: number,
  prepared?: PreparedPressureGeometryPort,
): boolean {
  if (stroke.style.opacity <= 0 || stroke.points.length < 3) return false;
  const source = stroke;
  if (stroke.offset !== undefined) {
    point = { x: point.x - stroke.offset.x, y: point.y - stroke.offset.y };
    stroke = strokeLocalGeometry(stroke);
    prepared = prepared?.local?.();
  }
  const index = pressureHitIndex(stroke, source, prepared);
  const outerTolerance = tolerance + pressureContourOutwardError(stroke.style.width);
  let nearPaint = false;
  for (const block of index.blocks) {
    if (!boundsMayContain(block.bounds, point, tolerance)) continue;
    for (
      let indexInBlock = block.firstBoundary;
      indexInBlock < Math.max(block.firstBoundary + 1, block.lastBoundary);
      indexInBlock += 1
    ) {
      const start = index.centers[indexInBlock]!;
      const end = index.centers[Math.min(indexInBlock + 1, index.centers.length - 1)]!;
      const capsule = {
        start: { center: start, radius: pressureRadius(start.pressure, stroke.style.width) },
        end: { center: end, radius: pressureRadius(end.pressure, stroke.style.width) },
      };
      if (pressureCapsuleContainsPoint(capsule, point, tolerance)) return true;
      nearPaint ||= pressureCapsuleContainsPoint(capsule, point, outerTolerance);
    }
  }
  if (!nearPaint) return false;
  const bounds = {
    minX: point.x - tolerance,
    minY: point.y - tolerance,
    maxX: point.x + tolerance,
    maxY: point.y + tolerance,
  };
  for (const polygon of pressurePaintAdditionSteps(index.centers, stroke.style.width, {
    bounds,
    nearPoint: { point, radius: outerTolerance },
    ...(prepared === undefined ? {} : { prepared }),
  })) {
    if (polygon === undefined || typeof polygon === "number") continue;
    if (pointInPolygon(point, polygon)) return true;
    for (let edge = 0; edge < polygon.length; edge += 1) {
      if (
        pointSegmentDistance(point, polygon[edge]!, polygon[(edge + 1) % polygon.length]!) <=
        tolerance
      )
        return true;
    }
  }
  return false;
}

function pressureHitIndex(
  stroke: StrokeElementV1,
  source: StrokeElementV1,
  prepared: PreparedPressureGeometryPort | undefined,
): PressureHitIndex {
  const samples = stroke.points;
  const cacheable =
    Object.isFrozen(samples) || (samples instanceof Float64Array && isStoredStroke(source));
  if (cacheable) {
    const cached = pressureHitIndexes.get(samples);
    if (
      cached?.width === stroke.style.width &&
      cached.rotation === stroke.rotation &&
      cached.pivotX === stroke.pivot.x &&
      cached.pivotY === stroke.pivot.y
    )
      return cached;
  }
  const centers = isStoredStroke(source)
    ? selectionStrokeCenters(stroke, prepared)
    : simplifyStrokeCenters(transformedStrokeCenters(stroke), stroke.style.width, true);
  const blocks = pressureBlocks(centers, stroke.style.width);
  // Keep index preparation in the same world coordinates as SVG serialization.
  const index = {
    width: stroke.style.width,
    rotation: stroke.rotation,
    pivotX: stroke.pivot.x,
    pivotY: stroke.pivot.y,
    centers,
    blocks,
  };
  if (cacheable) pressureHitIndexes.set(samples, index);
  return index;
}

function pressureBlocks(centers: readonly StrokeCenter[], width: number): PressureHitBlock[] {
  const blocks: PressureHitBlock[] = [];
  for (let first = 0; first < Math.max(1, centers.length - 1);) {
    const last = Math.min(first + 64, centers.length - 1);
    const points: PointV1[] = [];
    for (let index = first; index <= last; index += 1) {
      const center = centers[index]!;
      const radius = pressureRadius(center.pressure, width);
      points.push(
        { x: center.x - radius, y: center.y - radius },
        { x: center.x + radius, y: center.y + radius },
      );
    }
    blocks.push({ firstBoundary: first, lastBoundary: last, bounds: boundsFromPoints(points) });
    if (last === centers.length - 1) break;
    first = last;
  }
  return blocks;
}

function boundsMayContain(bounds: Bounds, point: PointV1, radius: number): boolean {
  return (
    point.x >= bounds.minX - radius &&
    point.y >= bounds.minY - radius &&
    point.x <= bounds.maxX + radius &&
    point.y <= bounds.maxY + radius
  );
}
