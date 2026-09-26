import { pressureCapsuleContainsPoint } from "../../domain/geometry/pressure-capsule-selection";
import type { Bounds } from "../../domain/geometry/primitives";
import { boundsIntersect } from "../../domain/geometry/public";
import type { PreparedPressureGeometryPort } from "../../domain/geometry/prepared-pressure-geometry";
import {
  visitPreparedPressureOutline,
  type PressureOutlinePiece,
} from "../../domain/geometry/pressure-outline";
import { preparePressureWindowSteps } from "../../domain/geometry/pressure-window";
import type { StrokeCenter } from "../../domain/geometry/stroke-path";
import type { PointV1 } from "../../domain/schema/public";

export interface PressurePaintQuery {
  readonly bounds?: Bounds;
  readonly prepared?: PreparedPressureGeometryPort | undefined;
  readonly nearPoint?: { readonly point: PointV1; readonly radius: number };
}

/** Keep ideal-nib hits cheap; only remaining queries need the final outward patches. */
export function* pressurePaintAdditionSteps(
  centers: readonly StrokeCenter[],
  width: number,
  query: PressurePaintQuery = {},
): Generator<readonly PointV1[] | number | undefined> {
  const pending: PressureOutlinePiece[] = [];
  let windowIndex = 0;
  for (let index = 0; index < Math.max(1, centers.length - 1); index += 1) {
    visitPreparedPressureOutline(
      centers,
      width,
      (piece) => {
        pending.push(piece);
        return false;
      },
      {
        firstBoundary: index,
        lastBoundary: Math.min(index + 1, centers.length - 1),
      },
    );
    if (pending.length === 64) {
      yield* windowAdditions(pending, windowIndex++, query);
      pending.length = 0;
    }
    if (index % 32 === 31) yield 32;
  }
  if (pending.length > 0) yield* windowAdditions(pending, windowIndex, query);
}

function* windowAdditions(
  pieces: readonly PressureOutlinePiece[],
  index: number,
  query: PressurePaintQuery,
): Generator<readonly PointV1[] | number | undefined> {
  if (query.bounds !== undefined && !boundsIntersect(query.bounds, windowBounds(pieces))) return;
  const near = query.nearPoint;
  if (
    near !== undefined &&
    !pieces.some((piece) =>
      pressureCapsuleContainsPoint(
        piece.kind === "dot" ? { start: piece, end: piece } : piece.capsule,
        near.point,
        near.radius,
      ),
    )
  )
    return;
  let window = query.prepared?.readWindow(index);
  if (window === undefined) {
    const steps = preparePressureWindowSteps(pieces);
    let step = steps.next();
    while (!step.done) {
      yield undefined;
      step = steps.next();
    }
    window = step.value;
    query.prepared?.publishWindow(index, window);
  }
  yield* window.additions;
}

function windowBounds(pieces: readonly PressureOutlinePiece[]): Bounds {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const piece of pieces) {
    const nibs = piece.kind === "dot" ? [piece] : [piece.capsule.start, piece.capsule.end];
    for (const { center, radius } of nibs) {
      minX = Math.min(minX, center.x - radius);
      minY = Math.min(minY, center.y - radius);
      maxX = Math.max(maxX, center.x + radius);
      maxY = Math.max(maxY, center.y + radius);
    }
  }
  return { minX, minY, maxX, maxY };
}
