import type { PointV1 } from "../schema/types";
import { arcTo, canonicalGeometryNumber, moveTo, quadraticTo } from "./svg-format";
import type { SvgPathPart } from "./svg-path-part";

interface PressurePoint extends PointV1 {
  readonly pressure: number;
}

interface PressureSlice {
  readonly firstBoundary: number | null;
  readonly lastBoundary: number | null;
}

type PressureCurve = readonly [PressurePoint, PressurePoint, PressurePoint];
type QuadraticSide = readonly [PointV1, PointV1, PointV1];

export type PressureOutlinePiece =
  | { readonly kind: "dot"; readonly center: PointV1; readonly radius: number }
  | {
      readonly kind: "strip";
      readonly left: QuadraticSide;
      readonly right: QuadraticSide;
      readonly start: PointV1;
      readonly end: PointV1;
      readonly startCap: boolean;
      readonly endCap: boolean;
      readonly startRadius: number;
      readonly endRadius: number;
    };

type StripPiece = Extract<PressureOutlinePiece, { kind: "strip" }>;

const COMPLETE_SLICE: PressureSlice = { firstBoundary: null, lastBoundary: null };
const MAXIMUM_TANGENT_SINE = 0.25;
const DEGENERATE_LENGTH = 1e-9;

/** Same-winding monotone ribbons keep continuous pressure and additive self-overlap. */
export function buildPressureOutline(
  centers: readonly PressurePoint[],
  width: number,
  slice: PressureSlice = COMPLETE_SLICE,
): SvgPathPart[] {
  const commands: string[] = [];
  let run: StripPiece[] = [];
  visitPressureOutline(
    centers,
    width,
    (piece) => {
      if (piece.kind === "dot") commands.push(serializeDot(piece));
      else {
        run.push(piece);
        if (piece.endCap) {
          commands.push(serializeRun(run));
          run = [];
        }
      }
      return false;
    },
    slice,
  );
  return [{ d: commands.join(""), paint: "fill" }];
}

/** Returns true on visitor-requested early exit. Pieces match the serialized outline. */
export function visitPressureOutline(
  centers: readonly PressurePoint[],
  width: number,
  visitor: (piece: PressureOutlinePiece) => boolean,
  slice: PressureSlice = COMPLETE_SLICE,
): boolean {
  assertInput(centers, width, slice);
  let run: StripPiece[] = [];
  const flush = (): boolean => {
    for (let index = 0; index < run.length; index += 1) {
      if (visitor({ ...run[index]!, startCap: index === 0, endCap: index === run.length - 1 }))
        return true;
    }
    run = [];
    return false;
  };
  let boundary = slice.firstBoundary ?? -1;
  for (const curve of centerlineCurves(centers, slice)) {
    boundary += 1;
    for (const curvePiece of boundedCurvePieces(curve)) {
      const piece = outlinePiece(curvePiece, width);
      if (piece.kind === "dot") {
        if (flush() || visitor(piece)) return true;
      } else {
        const previous = run[run.length - 1];
        if (previous !== undefined && !matchingSections(previous, piece) && flush()) return true;
        run.push(piece);
      }
    }
    // The live prefix retains four context samples and advances eight. Fixed
    // partitions make packed full paths and independently built slices identical.
    if (boundary % 8 === 3 && flush()) return true;
  }
  return flush();
}

function matchingSections(previous: StripPiece, next: StripPiece): boolean {
  return samePoint(previous.left[2], next.left[0]) && samePoint(previous.right[2], next.right[0]);
}

function samePoint(left: PointV1, right: PointV1): boolean {
  return left.x === right.x && left.y === right.y;
}

function serializeDot(piece: Extract<PressureOutlinePiece, { kind: "dot" }>): string {
  const left = roundedPoint({ x: piece.center.x - piece.radius, y: piece.center.y });
  const right = roundedPoint({ x: piece.center.x + piece.radius, y: piece.center.y });
  return `${moveTo(left)}${compactArc(piece.radius, left, right)}${compactArc(piece.radius, right, left)}Z`;
}

function serializeRun(run: readonly StripPiece[]): string {
  const first = run[0]!;
  const last = run[run.length - 1]!;
  const commands = [moveTo(first.left[0])];
  let current = first.left[0];
  for (const piece of run) {
    commands.push(compactQuadratic(piece.left[1], piece.left[2], current));
    current = piece.left[2];
  }
  commands.push(compactArc(last.endRadius, current, last.right[2]));
  current = last.right[2];
  for (let index = run.length - 1; index >= 0; index -= 1) {
    const piece = run[index]!;
    commands.push(compactQuadratic(piece.right[1], piece.right[0], current));
    current = piece.right[0];
  }
  commands.push(compactArc(first.startRadius, current, first.left[0]), "Z");
  return commands.join("");
}

function compactQuadratic(control: PointV1, end: PointV1, current: PointV1): string {
  if (!boundedCoordinates(control) || !boundedCoordinates(end) || !boundedCoordinates(current)) {
    return quadraticTo(control, end);
  }
  const controlX = Math.round(control.x * 1000);
  const controlY = Math.round(control.y * 1000);
  const endX = Math.round(end.x * 1000);
  const endY = Math.round(end.y * 1000);
  const currentX = Math.round(current.x * 1000);
  const currentY = Math.round(current.y * 1000);
  const relativeControl = { x: controlX - currentX, y: controlY - currentY };
  const relativeEnd = { x: endX - currentX, y: endY - currentY };
  const absoluteLength =
    positionLength(controlX, controlY, true) + positionLength(endX, endY, false);
  const relativeLength =
    positionLength(relativeControl.x, relativeControl.y, true, true) +
    positionLength(relativeEnd.x, relativeEnd.y, false, true);
  return boundedThousandths(relativeControl) &&
    boundedThousandths(relativeEnd) &&
    relativeLength < absoluteLength
    ? quadraticCommand("q", relativeControl, relativeEnd, 1000)
    : quadraticCommand("Q", control, end, 1);
}

function compactArc(radius: number, current: PointV1, end: PointV1): string {
  if (!boundedCoordinates(current) || !boundedCoordinates(end)) return arcTo(radius, 0, end);
  const endX = Math.round(end.x * 1000);
  const endY = Math.round(end.y * 1000);
  const relative = {
    x: endX - Math.round(current.x * 1000),
    y: endY - Math.round(current.y * 1000),
  };
  const useRelative =
    boundedThousandths(relative) &&
    positionLength(relative.x, relative.y, false, true) < positionLength(endX, endY, false);
  const endpoint = useRelative ? relative : end;
  const divisor = useRelative ? 1000 : 1;
  return `${useRelative ? "a" : "A"}${radius} ${radius} 0 0 0${followingCanonical(endpoint.x / divisor, useRelative)}${followingCanonical(endpoint.y / divisor, useRelative)}`;
}

function quadraticCommand(
  command: "Q" | "q",
  control: PointV1,
  end: PointV1,
  divisor: number,
): string {
  const compact = command === "q";
  return `${command}${canonicalText(control.x / divisor, compact)}${followingCanonical(control.y / divisor, compact)}${followingCanonical(end.x / divisor, compact)}${followingCanonical(end.y / divisor, compact)}`;
}

function canonicalText(value: number, compact: boolean): string {
  const text = String(value);
  if (!compact || value === 0 || Math.abs(value) >= 1) return text;
  return value < 0 ? `-${text.slice(2)}` : text.slice(1);
}

function followingCanonical(value: number, compact = false): string {
  const text = canonicalText(value, compact);
  return value < 0 ? text : ` ${text}`;
}

function positionLength(x: number, y: number, initial: boolean, compact = false): number {
  return (
    decimalLength(x, compact) +
    decimalLength(y, compact) +
    Number(!initial && x >= 0) +
    Number(y >= 0)
  );
}

function decimalLength(thousandths: number, compact: boolean): number {
  const absolute = Math.abs(thousandths);
  const integer = Math.floor(absolute / 1000);
  const digits = integerDigits(integer);
  const fraction =
    absolute % 1000 === 0 ? 0 : absolute % 10 !== 0 ? 4 : absolute % 100 !== 0 ? 3 : 2;
  return (
    digits + fraction + Number(thousandths < 0) - Number(compact && absolute > 0 && absolute < 1000)
  );
}

function integerDigits(integer: number): number {
  return integer < 10
    ? 1
    : integer < 100
      ? 2
      : integer < 1000
        ? 3
        : integer < 10000
          ? 4
          : integer < 100000
            ? 5
            : integer < 1000000
              ? 6
              : 7;
}

function boundedCoordinates(point: PointV1): boolean {
  return Math.abs(point.x) <= 1_000_000 && Math.abs(point.y) <= 1_000_000;
}

function boundedThousandths(point: PointV1): boolean {
  return Math.abs(point.x) <= 1_000_000_000 && Math.abs(point.y) <= 1_000_000_000;
}

function outlinePiece(curve: PressureCurve, width: number): PressureOutlinePiece {
  const [start, control, end] = curve;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  const roundedStart = roundedPoint(start);
  const roundedEnd = roundedPoint(end);
  if (distance <= DEGENERATE_LENGTH || samePoint(roundedStart, roundedEnd)) {
    return {
      kind: "dot",
      center: roundedStart,
      radius: radius(maximumPressure(curve), width),
    };
  }
  const normal = { x: -dy / distance, y: dx / distance };
  const radii = [
    radius(start.pressure, width),
    radius(control.pressure, width),
    radius(end.pressure, width),
  ] as const;
  const side = (sign: number): QuadraticSide => [
    offset(start, normal, sign * radii[0]),
    offset(control, normal, sign * radii[1]),
    offset(end, normal, sign * radii[2]),
  ];
  return {
    kind: "strip",
    left: side(1),
    right: side(-1),
    start: roundedStart,
    end: roundedEnd,
    startCap: true,
    endCap: true,
    startRadius: radii[0],
    endRadius: radii[2],
  };
}

function radius(pressure: number, width: number): number {
  return canonicalGeometryNumber((width * (0.35 + 0.65 * Math.max(0, Math.min(1, pressure)))) / 2);
}

function offset(center: PointV1, normal: PointV1, distance: number): PointV1 {
  return roundedPoint({ x: center.x + normal.x * distance, y: center.y + normal.y * distance });
}

function maximumPressure([start, control, end]: PressureCurve): number {
  const quadratic = start.pressure - 2 * control.pressure + end.pressure;
  const t = quadratic >= 0 ? 0 : (start.pressure - control.pressure) / quadratic;
  const interior =
    t > 0 && t < 1
      ? interpolate(interpolate(start, control, t), interpolate(control, end, t), t).pressure
      : start.pressure;
  return Math.max(start.pressure, end.pressure, interior);
}

function boundedCurvePieces(curve: PressureCurve): readonly PressureCurve[] {
  const regular = splitAtMinimumSpeed(curve);
  // Splitting at minimum speed makes each centerline monotone along its chord.
  // Each regular half can split once more; unsplit curves may split twice.
  const first = regular.length === 2 ? regular : subdivideForBend(curve);
  return first.flatMap(subdivideForBend);
}

function splitAtMinimumSpeed(curve: PressureCurve): readonly PressureCurve[] {
  const [start, control, end] = curve;
  const ux = control.x - start.x;
  const uy = control.y - start.y;
  const vx = end.x - 2 * control.x + start.x;
  const vy = end.y - 2 * control.y + start.y;
  const squared = vx * vx + vy * vy;
  const t = squared === 0 ? 0 : -(ux * vx + uy * vy) / squared;
  return t > 0 && t < 1 ? splitCurve(curve, t) : [curve];
}

function subdivideForBend(curve: PressureCurve): readonly PressureCurve[] {
  const [start, control, end] = curve;
  const chord = { x: end.x - start.x, y: end.y - start.y };
  const length = Math.hypot(chord.x, chord.y);
  if (length <= DEGENERATE_LENGTH) return [curve];
  const startSine = tangentSine({ x: control.x - start.x, y: control.y - start.y }, chord, length);
  const endSine = tangentSine({ x: end.x - control.x, y: end.y - control.y }, chord, length);
  return Math.max(startSine, endSine) > MAXIMUM_TANGENT_SINE ? splitCurve(curve, 0.5) : [curve];
}

function tangentSine(tangent: PointV1, chord: PointV1, chordLength: number): number {
  const length = Math.hypot(tangent.x, tangent.y);
  return length <= DEGENERATE_LENGTH
    ? 0
    : Math.abs(tangent.x * chord.y - tangent.y * chord.x) / (length * chordLength);
}

function splitCurve(
  [start, control, end]: PressureCurve,
  t: number,
): readonly [PressureCurve, PressureCurve] {
  const first = interpolate(start, control, t);
  const last = interpolate(control, end, t);
  const middle = interpolate(first, last, t);
  return [
    [start, first, middle],
    [middle, last, end],
  ];
}

function interpolate(start: PressurePoint, end: PressurePoint, t: number): PressurePoint {
  return {
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t,
    pressure: start.pressure + (end.pressure - start.pressure) * t,
  };
}

function centerlineCurves(
  centers: readonly PressurePoint[],
  slice: PressureSlice,
): PressureCurve[] {
  if (centers.length === 1) return [[centers[0]!, centers[0]!, centers[0]!]];
  if (centers.length === 2 && slice.firstBoundary === null && slice.lastBoundary === null) {
    return [[centers[0]!, interpolate(centers[0]!, centers[1]!, 0.5), centers[1]!]];
  }
  const curves: PressureCurve[] = [];
  if (slice.firstBoundary === null) {
    const first = centers[0]!;
    const boundary = interpolate(first, centers[1]!, 0.5);
    curves.push([first, interpolate(first, boundary, 0.5), boundary]);
  }
  for (
    let index = (slice.firstBoundary ?? 0) + 1;
    index <= (slice.lastBoundary ?? centers.length - 2);
    index += 1
  ) {
    const control = centers[index]!;
    curves.push([
      interpolate(centers[index - 1]!, control, 0.5),
      control,
      interpolate(control, centers[index + 1]!, 0.5),
    ]);
  }
  if (slice.lastBoundary === null) {
    const end = centers[centers.length - 1]!;
    const boundary = interpolate(centers[centers.length - 2]!, end, 0.5);
    curves.push([boundary, interpolate(boundary, end, 0.5), end]);
  }
  return curves;
}

function assertInput(centers: readonly PressurePoint[], width: number, slice: PressureSlice): void {
  if (centers.length < 1 || centers.length > 4096 || !Number.isFinite(width) || width <= 0) {
    throw new RangeError(
      "Pressure outlines require 1 through 4096 centers and a positive finite width.",
    );
  }
  for (const boundary of [slice.firstBoundary, slice.lastBoundary]) {
    if (
      boundary !== null &&
      (!Number.isInteger(boundary) || boundary < 0 || boundary > centers.length - 2)
    ) {
      throw new RangeError("Pressure outline slice boundaries are invalid.");
    }
  }
  if (
    slice.firstBoundary !== null &&
    slice.lastBoundary !== null &&
    slice.firstBoundary >= slice.lastBoundary
  ) {
    throw new RangeError("Pressure outline slice boundaries must advance.");
  }
  const first = slice.firstBoundary ?? 0;
  const last = slice.lastBoundary === null ? centers.length - 1 : slice.lastBoundary + 1;
  for (let index = first; index <= last; index += 1) {
    const center = centers[index]!;
    if (
      !Number.isFinite(center.x) ||
      !Number.isFinite(center.y) ||
      !Number.isFinite(center.pressure)
    ) {
      throw new RangeError("Pressure outlines require finite centers.");
    }
  }
}

function roundedPoint(point: PointV1): PointV1 {
  return { x: canonicalGeometryNumber(point.x), y: canonicalGeometryNumber(point.y) };
}
