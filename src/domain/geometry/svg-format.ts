import { canonicalizeGeometryNumber as canonicalGeometryNumber } from "../schema/canonical";
import type { PointV1 } from "../schema/types";

export { canonicalGeometryNumber };

export function svgNumber(value: number): string {
  return String(canonicalGeometryNumber(value));
}

export function moveTo(point: PointV1): string {
  return `M${svgNumber(point.x)}${followingNumber(point.y)}`;
}

export function lineTo(point: PointV1): string {
  return `L${svgNumber(point.x)}${followingNumber(point.y)}`;
}

export function quadraticTo(control: PointV1, end: PointV1): string {
  return (
    `Q${svgNumber(control.x)}${followingNumber(control.y)}` +
    `${followingNumber(end.x)}${followingNumber(end.y)}`
  );
}

export function cubicTo(first: PointV1, second: PointV1, end: PointV1): string {
  return (
    `C${svgNumber(first.x)}${followingNumber(first.y)}` +
    `${followingNumber(second.x)}${followingNumber(second.y)}` +
    `${followingNumber(end.x)}${followingNumber(end.y)}`
  );
}

export function arcTo(radius: number, sweep: 0 | 1, end: PointV1, large: 0 | 1 = 0): string {
  return `${arcPrefix(radius, sweep, large)}${followingNumber(end.x)}${followingNumber(end.y)}`;
}

export function arcPrefix(
  radius: number,
  sweep: 0 | 1,
  large: 0 | 1 = 0,
  relative = false,
): string {
  const value = relative ? String(radius) : svgNumber(radius);
  return `${relative ? "a" : "A"}${value} ${value} 0 ${large} ${sweep}`;
}

function followingNumber(value: number): string {
  const serialized = svgNumber(value);
  return serialized.startsWith("-") ? serialized : ` ${serialized}`;
}
