import type { PreparedPressureGeometryPort } from "./prepared-pressure-geometry";
import { pressureShapeBoundary } from "./pressure-union";
import type { PointV1 } from "../schema/types";
import { pressureArcPoint, type PressureBoundaryArc } from "./pressure-joins";
import type { PressureOutlinePiece } from "./pressure-outline-piece";
import { arcTo, canonicalGeometryNumber, lineTo, moveTo } from "./svg-format";

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
  return serializePressureWindows([
    {
      kind: "window",
      additions: [],
      loops: pieces.map((piece) =>
        pressureShapeBoundary(piece.kind === "dot" ? piece : piece.capsule),
      ),
    },
  ]);
}
export function serializePressureWindows(windows: readonly PressureWindow[]): string {
  const commands: string[] = [];
  for (const window of windows) {
    for (const loop of window.loops) {
      if (loop.length === 0) continue;
      const ordered = rotatedLoop(loop);
      const path = [moveTo(ordered[0]!.start)];
      for (const [index, segment] of ordered.entries()) {
        if (index === ordered.length - 1 && segment.kind === "line") continue;
        if (segment.kind === "line") path.push(compactLine(segment.start, segment.end));
        else appendArc(path, segment);
      }
      path.push("Z");
      commands.push(joinCommands(path));
    }
  }
  return commands.join("");
}

function rotatedLoop(loop: PressureWindow["loops"][number]): PressureWindow["loops"][number] {
  let best = 0;
  let score = -Infinity;
  for (let index = 0; index < loop.length; index += 1) {
    const closing = loop[(index + loop.length - 1) % loop.length]!;
    if (closing.kind !== "line") continue;
    const [x, y] = relativePair(closing.start, closing.end);
    const value = `l${numberText(x)} ${numberText(y)}`.length - moveTo(loop[index]!.start).length;
    if (value > score) {
      score = value;
      best = index;
    }
  }
  return [...loop.slice(best), ...loop.slice(0, best)];
}

function appendArc(commands: string[], boundary: PressureBoundaryArc): void {
  const count = Math.max(1, Math.ceil(Math.abs(boundary.sweep) / (Math.PI / 2)));
  let previous = boundary.start;
  for (let index = 1; index <= count; index += 1) {
    const end = pressureArcPoint(boundary, index / count);
    if (Math.abs(boundary.sweep) > 1e-12)
      commands.push(compactArc(boundary.radius, previous, end, boundary.sweep > 0 ? 1 : 0));
    previous = end;
  }
}

function compactLine(start: PointV1, end: PointV1): string {
  const absolute = lineTo(end);
  const [x, y] = relativePair(start, end);
  const relative = `l${numberText(x)}${separator(x, y)}${numberText(y)}`;
  let result = bounded(x, y) && relative.length < absolute.length ? relative : absolute;
  const axis = x === 0 ? `v${numberText(y)}` : y === 0 ? `h${numberText(x)}` : undefined;
  if (axis !== undefined && bounded(x, y) && axis.length < result.length) result = axis;
  return result;
}
function compactArc(radius: number, start: PointV1, end: PointV1, sweep: 0 | 1): string {
  const absolute = arcTo(radius, sweep, end);
  const [x, y] = relativePair(start, end);
  const relative = `a${radius} ${radius} 0 0 ${sweep}${x < 0 ? "" : " "}${numberText(x)}${separator(x, y)}${numberText(y)}`;
  return bounded(x, y) && relative.length < absolute.length ? relative : absolute;
}
function relativePair(start: PointV1, end: PointV1): readonly [number, number] {
  return [
    canonicalGeometryNumber(canonicalGeometryNumber(end.x) - canonicalGeometryNumber(start.x)),
    canonicalGeometryNumber(canonicalGeometryNumber(end.y) - canonicalGeometryNumber(start.y)),
  ];
}
function numberText(value: number): string {
  return String(value).replace(/^(-?)0\./, "$1.");
}
function separator(x: number, y: number): string {
  return y < 0 || (numberText(x).includes(".") && numberText(y).startsWith(".")) ? "" : " ";
}
function bounded(x: number, y: number): boolean {
  return Math.abs(x) <= 1_000_000 && Math.abs(y) <= 1_000_000;
}
function joinCommands(commands: readonly string[]): string {
  let previous = "";
  return commands
    .map((command) => {
      const kind = command[0]!;
      const result =
        kind === "l" && previous === "l" && command[1] === "-" ? command.slice(1) : command;
      previous = kind;
      return result;
    })
    .join("");
}
