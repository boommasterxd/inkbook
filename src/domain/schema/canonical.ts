const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RGBA_PATTERN = /^#[0-9A-F]{8}$/;
const MAXIMUM_FAST_ABSOLUTE_VALUE = 2_000_000;
const ROUNDING_SCALE = 1_000;
const UNIT_INTERVAL_SCALE = 10_000;

function canonicalizeDecimal(value: number, decimals: number): number {
  const rounded = Number(value.toFixed(decimals));
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function canonicalizeGeometryNumber(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError("Geometry values must be finite.");
  }
  if (Math.abs(value) > MAXIMUM_FAST_ABSOLUTE_VALUE) return canonicalizeDecimal(value, 3);
  const scaled = value * ROUNDING_SCALE;
  const fraction = Math.abs(scaled - Math.trunc(scaled));
  const multiplicationError = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 2;
  // Multiplication can hide which side of a decimal tie the original double is on.
  // Preserve toFixed semantics near those ties, including negative half values.
  if (Math.abs(fraction - 0.5) <= multiplicationError) return canonicalizeDecimal(value, 3);
  const rounded = Math.round(scaled) / ROUNDING_SCALE;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function canonicalizeUnitIntervalNumber(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError("Unit interval values must be finite.");
  }
  return canonicalizeDecimal(value, 4);
}

export function canonicalizeRotation(value: number): number {
  const canonical = canonicalizeGeometryNumber(value);
  const normalized = ((((canonical + 180) % 360) + 360) % 360) - 180;
  return canonicalizeGeometryNumber(normalized);
}

export function isCanonicalGeometryNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    !Object.is(value, -0) &&
    Object.is(value, canonicalizeGeometryNumber(value))
  );
}

export function isCanonicalUnitIntervalNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    value >= 0 &&
    value <= 1 &&
    !Object.is(value, -0) &&
    // Membership in the four-decimal grid does not require decimal string formatting.
    Object.is(value, Math.round(value * UNIT_INTERVAL_SCALE) / UNIT_INTERVAL_SCALE)
  );
}

export function isCanonicalRotation(value: unknown): value is number {
  return (
    isCanonicalGeometryNumber(value) &&
    value >= -180 &&
    value < 180 &&
    Object.is(value, canonicalizeRotation(value))
  );
}

export function isLowercaseUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

export function isRgbaColor(value: unknown): value is `#${string}` {
  return typeof value === "string" && RGBA_PATTERN.test(value);
}
