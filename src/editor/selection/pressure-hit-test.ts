import { isStoredStroke } from "../../domain/elements/stroke-replacement-proof";
import {
  visitPressureOutline,
  type PressureOutlinePiece,
} from "../../domain/geometry/pressure-outline";
import {
  boundsFromPoints,
  pointSegmentDistance,
  pointInPolygon,
  type Bounds,
} from "../../domain/geometry/public";
import { smoothStrokeCenters, type StrokeCenter } from "../../domain/geometry/stroke-path";
import type { PointV1, StrokeElementV1 } from "../../domain/schema/public";

import { visitPressureSelectionPrimitives } from "./pressure-selection-primitives";
import type { VisibleSelectionPrimitive } from "./selection-area-primitives";

interface PressureHitBlock {
  readonly bounds: Bounds;
  readonly firstBoundary: number | null;
  readonly lastBoundary: number | null;
}

const BLOCK_SIZE = 64;
interface PressureHitIndex {
  readonly centers: readonly StrokeCenter[];
  readonly blocks: readonly PressureHitBlock[];
}

const pressureHitIndexes = new WeakMap<object, PressureHitIndex>();

/** Receives an unrotated point; widths stay separate so style changes reuse the index. */
export function pressureStrokeContainsPoint(
  stroke: StrokeElementV1,
  point: PointV1,
  tolerance: number,
): boolean {
  if (stroke.style.opacity <= 0 || stroke.points.length < 3) return false;
  const maxRadius = tolerance + stroke.style.width / 2;
  const index = pressureHitIndex(stroke);
  for (const block of index.blocks) {
    if (!boundsMayContain(block.bounds, point, maxRadius)) continue;
    if (
      visitPressureOutline(
        index.centers,
        stroke.style.width,
        (piece) => pieceContainsPoint(piece, point, tolerance),
        block,
      )
    )
      return true;
  }
  return false;
}

function pressureHitIndex(stroke: StrokeElementV1): PressureHitIndex {
  const samples = stroke.points;
  const cacheable =
    Object.isFrozen(samples) || (samples instanceof Float64Array && isStoredStroke(stroke));
  if (cacheable) {
    const cached = pressureHitIndexes.get(samples);
    if (cached !== undefined) return cached;
  }
  const centers = smoothStrokeCenters(samples);
  const blocks = createBlocks(centers);
  const index = { centers, blocks };
  if (cacheable) pressureHitIndexes.set(samples, index);
  return index;
}

function createBlocks(centers: readonly StrokeCenter[]): PressureHitBlock[] {
  if (centers.length <= 2) {
    return [{ bounds: boundsFromPoints(centers), firstBoundary: null, lastBoundary: null }];
  }
  const blocks: PressureHitBlock[] = [];
  // Run boundaries at control indices 3 modulo 8 are already capped by the canonical outline.
  // Starting there keeps index slices from inventing internal endpoint caps.
  for (let first = 1; first < centers.length - 1;) {
    const last = Math.min(centers.length - 2, first === 1 ? 3 : first + BLOCK_SIZE - 1);
    blocks.push({
      bounds: boundsFromPoints(centers.slice(first - 1, last + 2)),
      firstBoundary: first === 1 ? null : first - 1,
      lastBoundary: last === centers.length - 2 ? null : last,
    });
    first = last + 1;
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

function pieceContainsPoint(
  piece: PressureOutlinePiece,
  point: PointV1,
  tolerance: number,
): boolean {
  if (piece.kind === "strip") {
    const bounds = boundsFromPoints([...piece.left, ...piece.right, piece.start, piece.end]);
    const radius = Math.max(piece.startRadius, piece.endRadius);
    if (!boundsMayContain(bounds, point, tolerance + radius)) return false;
  }
  return !visitPressureSelectionPrimitives(
    piece,
    (primitive) => !primitiveContainsPoint(primitive, point, tolerance),
  );
}

function primitiveContainsPoint(
  primitive: VisibleSelectionPrimitive,
  point: PointV1,
  tolerance: number,
): boolean {
  if (primitive.kind === "capsule") {
    return (
      pointSegmentDistance(point, primitive.start, primitive.end) <= tolerance + primitive.radius
    );
  }
  if (pointInPolygon(point, primitive.points)) return true;
  for (let index = 0; index < primitive.points.length; index += 1) {
    const next = (index + 1) % primitive.points.length;
    if (
      pointSegmentDistance(point, primitive.points[index]!, primitive.points[next]!) <= tolerance
    ) {
      return true;
    }
  }
  return false;
}
