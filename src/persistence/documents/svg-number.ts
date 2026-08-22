const MAXIMUM_PRECISION = 3;
const CANONICAL_SVG_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/u;
const CANONICAL_SVG_OPACITY = /^(?:0(?:\.\d{1,4})?|1)$/u;

export function serializeSvgNumber(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) > 1_000_000) {
    throw new RangeError("invalid-svg-number");
  }
  const rounded = Math.round(value * 10 ** MAXIMUM_PRECISION) / 10 ** MAXIMUM_PRECISION;
  return Object.is(rounded, -0) ? "0" : rounded.toString();
}

export function parseCanonicalSvgDecimal(
  value: string | undefined,
  maximum: number,
): number | null {
  if (value === undefined || !CANONICAL_SVG_DECIMAL.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed <= maximum && parsed.toString() === value
    ? parsed
    : null;
}

export function parseCanonicalSvgOpacity(value: string | undefined): number | null {
  if (value === undefined || !CANONICAL_SVG_OPACITY.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed.toString() === value ? parsed : null;
}

export function serializeSvgOpacity(value: number): string {
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1 ||
    Object.is(value, -0) ||
    Math.round(value * 10_000) / 10_000 !== value
  ) {
    throw new RangeError("invalid-svg-opacity");
  }
  return value.toString();
}
