import { buildPressureOutline } from "./pressure-outline";
import { midpoint } from "./primitives";
import { lineTo, moveTo, quadraticTo } from "./svg-format";
import { buildCenterline, type StrokeCenter, type StrokePathGeometry } from "./stroke-path";

export interface StrokePathSlice {
  readonly firstBoundary: number | null;
  readonly lastBoundary: number | null;
}

export function buildCenterlineSlice(
  centers: readonly StrokeCenter[],
  slice: StrokePathSlice,
): StrokePathGeometry {
  assertSlice(centers, slice);
  if (isCompleteSlice(slice)) return [{ d: buildCenterline(centers), paint: "stroke" }];
  const start = slice.firstBoundary;
  const commands = [moveTo(start === null ? centers[0]! : boundary(centers, start))];
  appendForwardSide(commands, centers, slice);
  return [{ d: commands.join(""), paint: "stroke" }];
}

export function buildPressureOutlineSlice(
  centers: readonly StrokeCenter[],
  width: number,
  slice: StrokePathSlice,
): StrokePathGeometry {
  assertSlice(centers, slice);
  return buildPressureOutline(centers, width, slice);
}

function isCompleteSlice(slice: StrokePathSlice): boolean {
  return slice.firstBoundary === null && slice.lastBoundary === null;
}

function appendForwardSide(
  commands: string[],
  points: readonly StrokeCenter[] | readonly { readonly x: number; readonly y: number }[],
  slice: StrokePathSlice,
): void {
  const firstBoundary = slice.firstBoundary;
  const lastBoundary = slice.lastBoundary;
  let nextControl = firstBoundary === null ? 1 : firstBoundary + 1;
  if (firstBoundary === null) commands.push(lineTo(boundary(points, 0)));
  const finalBoundary = lastBoundary ?? points.length - 2;
  for (; nextControl <= finalBoundary; nextControl += 1) {
    commands.push(quadraticTo(points[nextControl]!, boundary(points, nextControl)));
  }
  if (lastBoundary === null) commands.push(lineTo(points[points.length - 1]!));
}

function boundary(
  points: readonly { readonly x: number; readonly y: number }[],
  index: number,
): { readonly x: number; readonly y: number } {
  return midpoint(points[index]!, points[index + 1]!);
}

function assertSlice(centers: readonly StrokeCenter[], slice: StrokePathSlice): void {
  if (centers.length === 0) throw new RangeError("A stroke slice requires at least one center.");
  const maximumBoundary = centers.length - 2;
  const { firstBoundary, lastBoundary } = slice;
  if (
    (firstBoundary !== null && (firstBoundary < 0 || firstBoundary > maximumBoundary)) ||
    (lastBoundary !== null && (lastBoundary < 0 || lastBoundary > maximumBoundary)) ||
    (firstBoundary !== null && lastBoundary !== null && firstBoundary >= lastBoundary) ||
    (centers.length === 1 && (firstBoundary !== null || lastBoundary !== null))
  ) {
    throw new RangeError("Stroke slice boundaries are invalid.");
  }
}
