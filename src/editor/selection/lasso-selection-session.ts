import {
  assertFinitePoint,
  pointDistance,
  pointSegmentDistance,
} from "../../domain/geometry/public";
import type { PointV1 } from "../../domain/schema/public";

import {
  createLassoSelectionArea,
  MAX_LASSO_SELECTION_POINTS,
  type SelectionArea,
} from "./selection-area";

const INITIAL_SAMPLE_DISTANCE_PIXELS = 1.5;
const COMPACTION_TARGET_POINTS = Math.floor(MAX_LASSO_SELECTION_POINTS / 2);

export class LassoSelectionSession {
  readonly #zoom: number;
  #points: PointV1[];
  #simplificationPixels = INITIAL_SAMPLE_DISTANCE_PIXELS;

  public constructor(start: PointV1, zoom: number) {
    assertFinitePoint(start, "Lasso points must contain finite coordinates.");
    if (!Number.isFinite(zoom) || zoom <= 0) {
      throw new RangeError("Lasso zoom must be positive and finite.");
    }
    this.#points = [copyPoint(start)];
    this.#zoom = zoom;
  }

  public get points(): readonly PointV1[] {
    return this.#points;
  }

  public append(point: PointV1): boolean {
    return this.appendBatch([point]);
  }

  public appendBatch(points: readonly PointV1[]): boolean {
    let changed = false;
    for (const point of points) {
      assertFinitePoint(point, "Lasso points must contain finite coordinates.");
      const previous = this.#points[this.#points.length - 1]!;
      if (pointDistance(previous, point) * this.#zoom < this.#simplificationPixels) continue;
      this.#points.push(copyPoint(point));
      changed = true;
      if (this.#points.length > MAX_LASSO_SELECTION_POINTS) this.#compact();
    }
    return changed;
  }

  public selectionArea(): SelectionArea | null {
    try {
      return createLassoSelectionArea(this.#points);
    } catch (error: unknown) {
      if (error instanceof RangeError) return null;
      throw error;
    }
  }

  #compact(): void {
    let tolerancePixels = this.#simplificationPixels;
    let compacted = this.#points;
    do {
      tolerancePixels *= 2;
      compacted = simplifyPolyline(this.#points, tolerancePixels / this.#zoom);
    } while (compacted.length > COMPACTION_TARGET_POINTS);
    this.#points = compacted;
    this.#simplificationPixels = tolerancePixels;
  }
}

function simplifyPolyline(points: readonly PointV1[], tolerance: number): PointV1[] {
  if (points.length <= 2) return points.map(copyPoint);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const ranges: Array<readonly [number, number]> = [[0, points.length - 1]];
  while (ranges.length > 0) {
    const [startIndex, endIndex] = ranges.pop()!;
    const start = points[startIndex]!;
    const end = points[endIndex]!;
    let farthestIndex = -1;
    let farthestDistance = tolerance;
    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const candidateDistance = pointSegmentDistance(points[index]!, start, end);
      if (candidateDistance > farthestDistance) {
        farthestDistance = candidateDistance;
        farthestIndex = index;
      }
    }
    if (farthestIndex < 0) continue;
    keep[farthestIndex] = 1;
    ranges.push([startIndex, farthestIndex], [farthestIndex, endIndex]);
  }
  return points.filter((_, index) => keep[index] === 1).map(copyPoint);
}

function copyPoint(point: PointV1): PointV1 {
  return { x: point.x, y: point.y };
}
