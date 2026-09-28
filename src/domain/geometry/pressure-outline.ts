import type { PreparedPressureGeometryPort } from "./prepared-pressure-geometry";
import type { PressureOutlinePiece } from "./pressure-outline-piece";
import { assertPressureOutlineInput } from "./pressure-outline-validation";
import {
  buildPressureCapsule,
  buildPressureCapsuleFromNibs,
  preparePressureNib,
  type PressureCenter,
} from "./pressure-joins";
import type { PressureDisk, PressureCapsule } from "./pressure-joins";
import { pressureRadius } from "./pressure-radius";
import { simplifyStrokeCenters } from "./stroke-simplification";
import type { SvgPathPart } from "./svg-path-part";
import { serializePressurePieces } from "./pressure-path-serialization";

interface PressureSlice {
  readonly firstBoundary: number | null;
  readonly lastBoundary: number | null;
}
export type { PressureOutlinePiece } from "./pressure-outline-piece";
const COMPLETE_SLICE: PressureSlice = { firstBoundary: null, lastBoundary: null };

export function buildPressureOutline(
  centers: readonly PressureCenter[],
  width: number,
  pressureGeometry?: PreparedPressureGeometryPort,
): SvgPathPart[] {
  const pieces: PressureOutlinePiece[] = [];
  visitPressureOutline(centers, width, (piece) => {
    pieces.push(piece);
    return false;
  });
  return [{ d: serializePressurePieces(pieces, pressureGeometry), paint: "fill" }];
}

export function visitPressureOutline(
  centers: readonly PressureCenter[],
  width: number,
  visitor: (piece: PressureOutlinePiece) => boolean,
): boolean {
  assertPressureOutlineInput(centers, width);
  return visitPreparedPressureOutline(simplifyStrokeCenters(centers, width, true), width, visitor);
}

/** Prepared slice boundaries index exact centers, with neighbors retained as join context. */
export function visitPreparedPressureOutline(
  centers: readonly PressureCenter[],
  width: number,
  visitor: (piece: PressureOutlinePiece) => boolean,
  slice: PressureSlice = COMPLETE_SLICE,
): boolean {
  if (centers.length === 1)
    return visitor({
      kind: "dot",
      center: centers[0]!,
      radius: pressureRadius(centers[0]!.pressure, width),
    });
  const first = slice.firstBoundary ?? 0;
  const last = slice.lastBoundary ?? centers.length - 1;
  if (first >= last) return false;
  let start = preparePressureNib(centers[first]!, width);
  for (let index = first; index < last; index += 1) {
    const end = preparePressureNib(centers[index + 1]!, width);
    const capsule = buildPressureCapsuleFromNibs(start, end);
    start = end;
    if (capsule.kind === "dot") {
      if (coveredDisk(centers, index, width, capsule)) continue;
      if (visitor(capsule)) return true;
      continue;
    }
    if (visitor({ kind: "strip", capsule, width })) return true;
  }
  return false;
}

function coveredDisk(
  centers: readonly PressureCenter[],
  index: number,
  width: number,
  disk: PressureDisk,
): boolean {
  for (const adjacent of [index - 1, index + 1]) {
    if (adjacent < 0 || adjacent >= centers.length - 1) continue;
    const neighbor = buildPressureCapsule(centers[adjacent]!, centers[adjacent + 1]!, width);
    if (
      neighbor.kind === "capsule" &&
      [neighbor.start, neighbor.end].some((nib) => containsDisk(nib, disk))
    )
      return true;
    if (
      neighbor.kind === "dot" &&
      containsDisk(neighbor, disk) &&
      (neighbor.radius > disk.radius || adjacent < index)
    )
      return true;
  }
  return false;
}
function containsDisk(
  outer: PressureDisk | PressureCapsule["start"],
  inner: PressureDisk,
): boolean {
  return (
    Math.hypot(outer.center.x - inner.center.x, outer.center.y - inner.center.y) + inner.radius <=
    outer.radius
  );
}
