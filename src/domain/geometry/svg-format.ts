import { MAX_ABSOLUTE_COORDINATE } from "../schema/constants";
import type { PointV1 } from "../schema/types";
import { roundCanonical } from "./primitives";

const MAXIMUM_FAST_ABSOLUTE_VALUE = MAX_ABSOLUTE_COORDINATE * 2;
const ROUNDING_SCALE = 1_000;

function svgNumber(value: number): string {
  return String(fastCanonicalGeometryNumber(value));
}

function fastCanonicalGeometryNumber(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > MAXIMUM_FAST_ABSOLUTE_VALUE) {
    return roundCanonical(value);
  }
  const scaled = value * ROUNDING_SCALE;
  const fraction = Math.abs(scaled - Math.trunc(scaled));
  const multiplicationError = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 2;
  if (Math.abs(fraction - 0.5) <= multiplicationError) return roundCanonical(value);
  const rounded = Math.round(scaled) / ROUNDING_SCALE;
  return Object.is(rounded, -0) ? 0 : rounded;
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
  const value = svgNumber(radius);
  return `A${value} ${value} 0 ${large} ${sweep}${followingNumber(end.x)}${followingNumber(end.y)}`;
}

function followingNumber(value: number): string {
  const serialized = svgNumber(value);
  return serialized.startsWith("-") ? serialized : ` ${serialized}`;
}
