import type {
  PreparedPressureGeometryPort,
  PressureWindow,
  PressureWindowMeasurement,
  PressurePathWindow,
  PressurePreparationMode,
} from "./prepared-pressure-geometry";
import { iteratePressureContourApproximation } from "./pressure-contour-approximation";
import type { PointV1 } from "../../schema/types";
import type { PressureOutlinePiece } from "./pressure-outline-piece";
import { iteratePressureUnion } from "./pressure-union";
import { pressureAdditionCount, type PressureAdditions } from "./pressure-additions";
import { MAX_PRESSURE_BOUNDARY_SCALAR_ENTRIES } from "./pressure-boundary-scalars";

export type { PressureWindow } from "./prepared-pressure-geometry";

/** Conservative numeric payload reserved for one suspended preparation job, not JS heap overhead.
 * 64 sources (64 scalars each, including cached arc starts);
 * 256 source-boundary scalar entries (at most three scalars each);
 * 1,025 guarded union edges including stitching (32 scalars);
 * two 505-interval buffers; 26 cut values; 1,024 completed contour edges (four coordinates);
 * 4,097 active polyline slots including rewrite/rounding arrays (16 scalars);
 * at most 16,384 retained plus 16,384 active addition triangles (six coordinates).
 */
export const PRESSURE_WINDOW_SCRATCH_BYTES =
  (64 * 64 +
    MAX_PRESSURE_BOUNDARY_SCALAR_ENTRIES * 3 +
    1025 * 32 +
    2 * 505 * 2 +
    26 +
    1024 * 4 +
    4097 * 16 +
    32768 * 6) *
  8;

/** Independent unions partition the emitted capsule stream, never raw input windows. */
export function preparePressureWindows(
  pieces: readonly PressureOutlinePiece[],
  pressureGeometry?: PreparedPressureGeometryPort,
): PressureWindow[] {
  const windows: PressureWindow[] = [];
  for (let start = 0; start < pieces.length; start += 64) {
    const cached = pressureGeometry?.readWindow(start / 64);
    if (cached !== undefined) {
      windows.push(cached);
      continue;
    }
    const steps = preparePressureWindowSteps(pieces.slice(start, start + 64));
    let step = steps.next();
    while (!step.done) step = steps.next();
    windows.push(step.value);
    pressureGeometry?.publishWindow(start / 64, step.value);
  }
  return windows;
}

/** Cold consumers may cancel between the same union operations used by canonical rendering. */
export function preparePressureWindowSteps(
  pieces: readonly PressureOutlinePiece[],
  mode?: "full",
): Generator<void, PressureWindow>;
export function preparePressureWindowSteps(
  pieces: readonly PressureOutlinePiece[],
  mode: "path-only",
): Generator<void, PressurePathWindow>;
export function preparePressureWindowSteps(
  pieces: readonly PressureOutlinePiece[],
  mode?: PressurePreparationMode,
): Generator<void, PressureWindow | PressurePathWindow>;
export function* preparePressureWindowSteps(
  pieces: readonly PressureOutlinePiece[],
  mode: PressurePreparationMode = "full",
): Generator<void, PressureWindow | PressurePathWindow> {
  const capsules = pieces.map((piece) => (piece.kind === "dot" ? piece : piece.capsule));
  const result = yield* iteratePressureUnion(capsules);
  const additions: PressureAdditions = mode === "full" ? [] : { count: 0 };
  const width = pieces.find((piece) => piece.kind === "strip")?.width;
  const loops = [];
  let commands = 0;
  for (const contour of result.contours) {
    loops.push(
      width === undefined || result.usedFallback
        ? contour
        : yield* iteratePressureContourApproximation(contour, width, additions),
    );
    const completed = loops[loops.length - 1]!;
    commands +=
      2 +
      completed.reduce(
        (count, edge) =>
          count +
          (edge.kind === "line" ? 1 : Math.max(1, Math.ceil(Math.abs(edge.sweep) / (Math.PI / 2)))),
        0,
      );
    // One bounded contour can add at most four triangles per input polyline point.
    // Reject before beginning another contour, bounding retained window additions.
    if (commands > pieces.length * 16 || pressureAdditionCount(additions) > 4 * 4096)
      return completedWindow(result.contours, mode === "full" ? [] : { count: 0 });
    yield;
  }
  return completedWindow(loops, additions);
}

function completedWindow(
  loops: PressureWindow["loops"],
  additions: PressureAdditions,
): PressureWindow | PressurePathWindow {
  return Array.isArray(additions)
    ? { kind: "window", loops, additions }
    : { kind: "path-window", loops };
}

/** Retained numeric payload; JavaScript object overhead depends on the runtime. */
export function pressureWindowMemoryUsage(window: PressureWindow | PressurePathWindow): number {
  if (window.kind === "path-window")
    return window.loops.reduce(
      (bytes, loop) =>
        bytes + loop.reduce((total, edge) => total + (edge.kind === "line" ? 32 : 64), 0),
      0,
    );
  return measurePressureWindow(window).numericBytes;
}

/** Measure accounting and optionally complete deep immutability in one boundary visit. */
export function measurePressureWindow(
  window: PressureWindow,
  freeze = false,
): PressureWindowMeasurement & { readonly retainedBytes: number } {
  const points = new Set<PointV1>();
  let scalarBytes = 0;
  let overhead = 160 + 48 + window.loops.length * 8;
  for (const loop of window.loops) {
    overhead += 48 + loop.length * 160;
    for (const segment of loop) {
      points.add(segment.start);
      points.add(segment.end);
      if (segment.kind === "arc") {
        points.add(segment.center);
        scalarBytes += 2 * 8;
      }
      if (freeze) Object.freeze(segment);
    }
    if (freeze) Object.freeze(loop);
  }
  overhead += 48 + window.additions.length * 8;
  for (const polygon of window.additions) {
    overhead += 48 + polygon.length * (8 + 24);
    for (const point of polygon) points.add(point);
    if (freeze) Object.freeze(polygon);
  }
  if (freeze) {
    for (const point of points) Object.freeze(point);
    Object.freeze(window.additions);
    Object.freeze(window.loops);
    Object.freeze(window);
  }
  const numericBytes = points.size * 2 * 8 + scalarBytes;
  return { window, numericBytes, retainedBytes: overhead + numericBytes };
}

/** Conservative retained-window accounting shared by store and presentation caches. */
export function pressureWindowRetainedBytes(window: PressureWindow): number {
  return measurePressureWindow(window).retainedBytes;
}

/** Numeric payload of a pending, unmerged capsule. */
export function pressureOutlinePieceMemoryUsage(piece: PressureOutlinePiece): number {
  if (piece.kind === "dot") return ("pressure" in piece.center ? 4 : 3) * 8;
  const capsule = piece.capsule;
  const points = new Set([
    capsule.start.center,
    capsule.end.center,
    capsule.left.start,
    capsule.left.end,
    capsule.right.start,
    capsule.right.end,
  ]);
  // Two nib radii, two cap radius/sweep pairs, heading, spread, and width.
  return points.size * 2 * 8 + 9 * 8;
}
