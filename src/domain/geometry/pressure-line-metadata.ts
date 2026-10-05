import type { PressureBoundaryLine } from "./pressure-joins";

export interface PressureLineMetadata {
  readonly dx: number;
  readonly dy: number;
  readonly lengthSquared: number;
}

export function pressureLineBounds(line: PressureBoundaryLine): {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
} {
  const minX = Math.min(line.start.x, line.end.x);
  const minY = Math.min(line.start.y, line.end.y);
  const maxX = Math.max(line.start.x, line.end.x);
  const maxY = Math.max(line.start.y, line.end.y);
  const pad =
    128 *
    Number.EPSILON *
    Math.max(1, Math.abs(minX), Math.abs(minY), Math.abs(maxX), Math.abs(maxY));
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

interface PressureLineCarrier {
  readonly length: number;
  readonly ux: number;
  readonly uy: number;
}

/** One canonical union window owns immutable metadata for unchanged source lines. */
export interface PressureLineMetadataCache {
  readonly directions: WeakMap<PressureBoundaryLine, PressureLineMetadata>;
  readonly carriers: WeakMap<PressureBoundaryLine, PressureLineCarrier>;
}

export function pressureLineMetadata(
  line: PressureBoundaryLine,
  cache?: PressureLineMetadataCache,
): PressureLineMetadata {
  const retained = cache?.directions.get(line);
  if (retained !== undefined) return retained;
  const dx = line.end.x - line.start.x;
  const dy = line.end.y - line.start.y;
  const metadata = { dx, dy, lengthSquared: dx * dx + dy * dy };
  cache?.directions.set(line, metadata);
  return metadata;
}

/** Normalize lazily: rejected carriers do not pay for a Euclidean length. */
export function pressureLineCarrier(
  line: PressureBoundaryLine,
  cache?: PressureLineMetadataCache,
): PressureLineCarrier {
  const retained = cache?.carriers.get(line);
  if (retained !== undefined) return retained;
  const direction = pressureLineMetadata(line, cache);
  const length = Math.hypot(direction.dx, direction.dy);
  const carrier = { length, ux: direction.dx / length, uy: direction.dy / length };
  cache?.carriers.set(line, carrier);
  return carrier;
}
