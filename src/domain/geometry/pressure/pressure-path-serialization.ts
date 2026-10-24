import type {
  PreparedPressureGeometryPort,
  PressurePathWindow,
} from "./prepared-pressure-geometry";
import { pressureShapeBoundary } from "./pressure-union";
import type { PointV1 } from "../../schema/types";
import { pressureArcPoint, type PressureBoundaryArc } from "./pressure-joins";
import type { PressureOutlinePiece } from "./pressure-outline-piece";
import { arcPrefix, canonicalGeometryNumber, moveTo, svgNumber } from "../svg-format";

import { preparePressureWindows, type PressureWindow } from "./pressure-window";
export {
  preparePressureWindows,
  pressureWindowMemoryUsage,
  pressureOutlinePieceMemoryUsage,
  type PressureWindow,
} from "./pressure-window";
/** Canonical and live records retain the same exact independently closed unions. */
export function serializePressurePieces(
  pieces: readonly PressureOutlinePiece[],
  pressureGeometry?: PreparedPressureGeometryPort,
): string {
  return serializePressureWindows(preparePressureWindows(pieces, pressureGeometry));
}
/** Cheap transient paint uses the exact union fill of separate capsule contours. */
export function serializePressureCapsules(pieces: readonly PressureOutlinePiece[]): string {
  const paths: string[] = [];
  for (const piece of pieces)
    appendLoop(paths, pressureShapeBoundary(piece.kind === "dot" ? piece : piece.capsule));
  return paths.join("");
}
export function serializePressureWindows(
  windows: readonly (PressureWindow | PressurePathWindow)[],
): string {
  const commands: string[] = [];
  for (const window of windows) {
    for (const loop of window.loops) {
      appendLoop(commands, loop);
    }
  }
  return commands.join("");
}

function appendLoop(paths: string[], loop: PressureWindow["loops"][number]): void {
  if (loop.length === 0) return;
  const offset = rotationIndex(loop);
  const path = [moveTo(loop[offset]!.start)];
  for (let index = 0; index < loop.length; index += 1) {
    const segment = loop[(offset + index) % loop.length]!;
    if (index === loop.length - 1 && segment.kind === "line") continue;
    if (segment.kind === "line") path.push(compactCommand(segment.start, segment.end));
    else appendArc(path, segment);
  }
  path.push("Z");
  paths.push(joinCommands(path));
}

function rotationIndex(loop: PressureWindow["loops"][number]): number {
  let best = 0;
  let score = -Infinity;
  for (let index = 0; index < loop.length; index += 1) {
    const closing = loop[(index + loop.length - 1) % loop.length]!;
    if (closing.kind !== "line") continue;
    const x = relativeCoordinate(closing.start.x, closing.end.x);
    const y = relativeCoordinate(closing.start.y, closing.end.y);
    const point = loop[index]!.start;
    const absoluteX = svgNumber(point.x);
    const absoluteY = svgNumber(point.y);
    const moveLength = 1 + absoluteX.length + followingLength(absoluteY);
    const value = 2 + numberText(x).length + numberText(y).length - moveLength;
    if (value > score) {
      score = value;
      best = index;
    }
  }
  return best;
}

function appendArc(commands: string[], boundary: PressureBoundaryArc): void {
  const count = Math.max(1, Math.ceil(Math.abs(boundary.sweep) / (Math.PI / 2)));
  const sweep = boundary.sweep > 0 ? 1 : 0;
  const absolutePrefix = arcPrefix(boundary.radius, sweep);
  const relativePrefix = arcPrefix(boundary.radius, sweep, 0, true);
  let previous = boundary.start;
  for (let index = 1; index <= count; index += 1) {
    const end = pressureArcPoint(boundary, index / count);
    if (Math.abs(boundary.sweep) > 1e-12)
      commands.push(compactCommand(previous, end, absolutePrefix, relativePrefix));
    previous = end;
  }
}

function compactCommand(
  start: PointV1,
  end: PointV1,
  absolutePrefix = "L",
  relativePrefix = "l",
): string {
  const line = absolutePrefix === "L";
  const x = relativeCoordinate(start.x, end.x);
  const y = relativeCoordinate(start.y, end.y);
  const absoluteX = svgNumber(end.x);
  const absoluteY = svgNumber(end.y);
  const absoluteLength =
    absolutePrefix.length +
    (line ? absoluteX.length : followingLength(absoluteX)) +
    followingLength(absoluteY);
  if (bounded(x, y)) {
    const xText = numberText(x);
    const yText = numberText(y);
    const separatorText = separator(xText, yText);
    const relativeLength =
      relativePrefix.length +
      Number(!line && x >= 0) +
      xText.length +
      separatorText.length +
      yText.length;
    const length = Math.min(relativeLength, absoluteLength);
    if (line) {
      if (x === 0 && 1 + yText.length < length) return `v${yText}`;
      if (y === 0 && 1 + xText.length < length) return `h${xText}`;
    }
    if (relativeLength < absoluteLength)
      return `${relativePrefix}${line || x < 0 ? "" : " "}${xText}${separatorText}${yText}`;
  }
  return `${absolutePrefix}${line || absoluteX.startsWith("-") ? "" : " "}${absoluteX}${absoluteY.startsWith("-") ? "" : " "}${absoluteY}`;
}
function relativeCoordinate(start: number, end: number): number {
  return canonicalGeometryNumber(canonicalGeometryNumber(end) - canonicalGeometryNumber(start));
}
function followingLength(value: string): number {
  return value.length + Number(!value.startsWith("-"));
}
function numberText(value: number): string {
  const text = String(value);
  if (text.startsWith("0.")) return text.slice(1);
  return text.startsWith("-0.") ? `-${text.slice(2)}` : text;
}
function separator(x: string, y: string): string {
  return y.startsWith("-") || (x.includes(".") && y.startsWith(".")) ? "" : " ";
}
function bounded(x: number, y: number): boolean {
  return Math.abs(x) <= 1_000_000 && Math.abs(y) <= 1_000_000;
}
function joinCommands(commands: string[]): string {
  let previous = "";
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index]!;
    const kind = command[0]!;
    if (kind === "l" && previous === "l" && command[1] === "-") commands[index] = command.slice(1);
    previous = kind;
  }
  return commands.join("");
}
