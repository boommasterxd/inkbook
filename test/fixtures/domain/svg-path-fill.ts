import { buildStrokePathParts } from "../../../src/domain/geometry/stroke-path";
import type { PreparedPressureGeometryPort } from "../../../src/domain/geometry/prepared-pressure-geometry";
import type { StrokeElementV1 } from "../../../src/domain/schema/types";
import type { PointV1 } from "../../../src/domain/schema/types";

export interface AbsoluteSvgCommand {
  readonly command: string;
  readonly values: readonly number[];
}

/** Independent SVG decoding; integer thousandths prevent relative-coordinate drift. */
export function decodeSvgPathCommands(path: string): AbsoluteSvgCommand[] {
  const decoded: AbsoluteSvgCommand[] = [];
  let current = [0, 0];
  let first = current;
  for (const match of path.matchAll(/([a-df-zA-DF-Z])([^a-df-zA-DF-Z]*)/g)) {
    const command = match[1]!;
    const kind = command.toUpperCase();
    if (!["M", "L", "H", "V", "A", "Q", "Z"].includes(kind))
      throw new Error(`Unsupported SVG command: ${command}`);
    const numbers = match[2]!.match(/[+-]?(?:\d*\.?\d+)(?:[eE][+-]?\d+)?/g)?.map(Number) ?? [];
    if (kind === "Z") {
      if (numbers.length > 0) throw new Error("Unexpected closepath coordinates");
      current = first;
      decoded.push({ command: "Z", values: [] });
      continue;
    }
    const arity = svgArity(kind);
    if (numbers.length === 0 || numbers.length % arity !== 0)
      throw new Error("Malformed SVG coordinates");
    for (let offset = 0; offset < numbers.length; offset += arity) {
      const values = absoluteValues(command, numbers.slice(offset, offset + arity), current);
      current = values.slice(-2).map((value) => Math.round(value * 1000));
      if (kind === "M" && offset === 0) first = current;
      decoded.push({ command: normalizedKind(kind, offset), values });
    }
  }
  return decoded;
}

function svgArity(kind: string): number {
  if (kind === "A") return 7;
  if (kind === "Q") return 4;
  return kind === "H" || kind === "V" ? 1 : 2;
}

function normalizedKind(kind: string, offset: number): string {
  return kind === "H" || kind === "V" || (kind === "M" && offset > 0) ? "L" : kind;
}

function absoluteValues(command: string, values: number[], origin: readonly number[]): number[] {
  if (command.toUpperCase() === "H" || command.toUpperCase() === "V") {
    const target = command.toUpperCase() === "H" ? 0 : 1;
    const endpoint = [...origin];
    endpoint[target] =
      Math.round(values[0]! * 1000) + (command === command.toLowerCase() ? origin[target]! : 0);
    return endpoint.map((value) => value / 1000);
  }
  const coordinateStart = command.toUpperCase() === "A" ? 5 : 0;
  const relative = command === command.toLowerCase();
  for (let index = coordinateStart; index < values.length; index += 1) {
    const offset = relative ? origin[(index - coordinateStart) % 2]! : 0;
    values[index] = (Math.round(values[index]! * 1000) + offset) / 1000;
  }
  return values;
}

/** Independently interprets line, quadratic and circular-arc pressure contours. */
export function sampleSvgPathContours(path: string): PointV1[][] {
  const contours: PointV1[][] = [];
  let contour: PointV1[] = [];
  let current = { x: 0, y: 0 };
  for (const { command, values } of decodeSvgPathCommands(path)) {
    if (command === "Z") {
      contours.push(contour);
      current = contour[0]!;
      contour = [];
      continue;
    }
    const end = { x: values[values.length - 2]!, y: values[values.length - 1]! };
    if (command === "M") contour = [end];
    else if (command === "A") contour.push(...sampleSvgArc(current, end, values));
    else if (command === "Q")
      contour.push(...sampleSvgQuadratic(current, { x: values[0]!, y: values[1]! }, end));
    else contour.push(end);
    current = end;
  }
  if (contour.length > 0) contours.push(contour);
  return contours;
}

/** The interpolation remainder bounds each chord's error by |A-2C+B| / (4 n²). */
function sampleSvgQuadratic(start: PointV1, control: PointV1, end: PointV1): PointV1[] {
  const curvature = Math.hypot(start.x - 2 * control.x + end.x, start.y - 2 * control.y + end.y);
  const count = Math.max(1, Math.ceil(Math.sqrt(curvature / 0.004)));
  return Array.from({ length: count }, (_, index) => {
    const fraction = (index + 1) / count;
    const opposite = 1 - fraction;
    return {
      x:
        opposite * opposite * start.x +
        2 * opposite * fraction * control.x +
        fraction * fraction * end.x,
      y:
        opposite * opposite * start.y +
        2 * opposite * fraction * control.y +
        fraction * fraction * end.y,
    };
  });
}

export function polygonWinding(points: readonly PointV1[], point: PointV1): number {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const first = points[index]!;
    const last = points[(index + 1) % points.length]!;
    const cross =
      (last.x - first.x) * (point.y - first.y) - (point.x - first.x) * (last.y - first.y);
    if (first.y <= point.y && last.y > point.y && cross > 0) total += 1;
    if (first.y > point.y && last.y <= point.y && cross < 0) total -= 1;
  }
  return total;
}

function sampleSvgArc(start: PointV1, end: PointV1, values: readonly number[]): PointV1[] {
  if (values[0] !== values[1] || values[2] !== 0) throw new Error("Expected a circular SVG arc");
  if (start.x === end.x && start.y === end.y) return [end];
  if (values[0] === 0) return [end];
  const x = (start.x - end.x) / 2;
  const y = (start.y - end.y) / 2;
  const squared = x * x + y * y;
  const radius = Math.max(Math.abs(values[0]!), Math.sqrt(squared));
  if (radius === 0) return [end];
  const factor =
    (values[3] === values[4] ? -1 : 1) *
    Math.sqrt(Math.max(0, (radius * radius - squared) / squared));
  const center = { x: (start.x + end.x) / 2 + factor * y, y: (start.y + end.y) / 2 - factor * x };
  const firstAngle = Math.atan2(start.y - center.y, start.x - center.x);
  let sweep = Math.atan2(end.y - center.y, end.x - center.x) - firstAngle;
  if (values[4] === 0 && sweep > 0) sweep -= 2 * Math.PI;
  if (values[4] === 1 && sweep < 0) sweep += 2 * Math.PI;
  const count = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 128)));
  return Array.from({ length: count }, (_, index) => {
    if (index === count - 1) return end;
    const angle = firstAngle + (sweep * (index + 1)) / count;
    return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
  });
}

/** Decode the actual serialized stroke and apply its SVG nonzero fill rule. */
export function strokeSvgContainsPoint(
  stroke: StrokeElementV1,
  point: PointV1,
  prepared?: PreparedPressureGeometryPort,
): boolean {
  const path = buildStrokePathParts(stroke, prepared)
    .map((part) => part.d)
    .join("");
  return (
    sampleSvgPathContours(path).reduce(
      (winding, contour) => winding + polygonWinding(contour, point),
      0,
    ) !== 0
  );
}
