import { type ResolvedShapeAnchor } from "../../domain/geometry/anchors";
import type { Bounds } from "../../domain/geometry/primitives";
import type { PointV1, ShapeAnchorV1 } from "../../domain/schema/public";

const SNAP_RADIUS = { mouse: 12, pen: 12, touch: 16 } as const;
const HYSTERESIS_PIXELS = 4;

export type SnapPointerType = keyof typeof SNAP_RADIUS;

export interface SnapCandidate {
  readonly anchor: ShapeAnchorV1;
  readonly anchorOrder: number;
  readonly distancePixels: number;
  readonly point: PointV1;
  readonly rank: number;
  readonly targetId: string;
}

export interface SpatialCandidateQuery {
  query(bounds: Bounds, sink: SpatialCandidateSink): void;
}

export interface SpatialCandidateSink {
  add(id: string): void;
}

export class SnapCandidateScratch implements SpatialCandidateSink {
  #allocationCount = 0;
  #ids: (string | undefined)[] = new Array<string | undefined>(16);
  #count = 0;

  public get allocationCount(): number {
    return this.#allocationCount;
  }

  public get count(): number {
    return this.#count;
  }

  public at(index: number): string {
    if (!Number.isInteger(index) || index < 0 || index >= this.#count) {
      throw new RangeError("Snap candidate scratch index is out of range.");
    }
    return this.#ids[index] as string;
  }

  public add(id: string): void {
    this.#ensureCapacity(this.#count + 1);
    this.#ids[this.#count] = id;
    this.#count += 1;
  }

  public clear(): void {
    for (let index = 0; index < this.#count; index += 1) this.#ids[index] = undefined;
    this.#count = 0;
  }

  #ensureCapacity(required: number): void {
    if (required <= this.#ids.length) return;
    const ids = new Array<string | undefined>(Math.max(required, this.#ids.length * 2));
    for (let index = 0; index < this.#count; index += 1) ids[index] = this.#ids[index];
    this.#ids = ids;
    this.#allocationCount += 1;
  }
}

export interface SnapTargetReader {
  get(id: string): SnapTarget | null;
}

export interface SnapTarget {
  readonly anchors: readonly ResolvedShapeAnchor[];
  readonly rank: number;
}

export interface SnapLookupInput {
  readonly current: SnapCandidate | null;
  readonly pointer: PointV1;
  readonly pointerType: SnapPointerType;
  readonly zoom: number;
}

function pageQueryBounds(point: PointV1, radiusPixels: number, zoom: number): Bounds {
  const radius = radiusPixels / zoom;
  return {
    minX: point.x - radius,
    minY: point.y - radius,
    maxX: point.x + radius,
    maxY: point.y + radius,
  };
}

function screenDistance(left: PointV1, right: PointV1, zoom: number): number {
  return Math.hypot(right.x - left.x, right.y - left.y) * zoom;
}

function candidateFromAnchor(
  targetId: string,
  rank: number,
  anchor: ResolvedShapeAnchor,
  pointer: PointV1,
  zoom: number,
): SnapCandidate {
  return {
    anchor: anchor.anchor,
    anchorOrder: anchor.order,
    distancePixels: screenDistance(pointer, anchor.point, zoom),
    point: anchor.point,
    rank,
    targetId,
  };
}

function candidatePrecedes(left: SnapCandidate, right: SnapCandidate): boolean {
  if (left.distancePixels !== right.distancePixels)
    return left.distancePixels < right.distancePixels;
  if (left.rank !== right.rank) return left.rank > right.rank;
  const targetComparison = left.targetId.localeCompare(right.targetId);
  return targetComparison !== 0 ? targetComparison < 0 : left.anchorOrder < right.anchorOrder;
}

function retainCurrent(
  input: SnapLookupInput,
  targets: SnapTargetReader,
  releaseRadius: number,
): SnapCandidate | null {
  if (input.current === null) return null;
  const target = targets.get(input.current.targetId);
  if (target === null) return null;
  const anchor = target.anchors.find((entry) => entry.order === input.current?.anchorOrder);
  if (anchor === undefined) return null;
  const candidate = candidateFromAnchor(
    input.current.targetId,
    target.rank,
    anchor,
    input.pointer,
    input.zoom,
  );
  return candidate.distancePixels <= releaseRadius ? candidate : null;
}

export function findSnapCandidate(
  input: SnapLookupInput,
  spatial: SpatialCandidateQuery,
  targets: SnapTargetReader,
  scratch: SnapCandidateScratch,
): SnapCandidate | null {
  if (!Number.isFinite(input.zoom) || input.zoom <= 0) return null;
  const radius = SNAP_RADIUS[input.pointerType];
  const retained = retainCurrent(input, targets, radius + HYSTERESIS_PIXELS);
  if (retained !== null) return retained;

  let best: SnapCandidate | null = null;
  const bounds = pageQueryBounds(input.pointer, radius, input.zoom);
  scratch.clear();
  spatial.query(bounds, scratch);
  try {
    for (let index = 0; index < scratch.count; index += 1) {
      const targetId = scratch.at(index);
      const target = targets.get(targetId);
      if (target === null) continue;
      for (const anchor of target.anchors) {
        const candidate = candidateFromAnchor(
          targetId,
          target.rank,
          anchor,
          input.pointer,
          input.zoom,
        );
        if (
          candidate.distancePixels <= radius &&
          (best === null || candidatePrecedes(candidate, best))
        ) {
          best = candidate;
        }
      }
    }
  } finally {
    scratch.clear();
  }
  return best;
}
