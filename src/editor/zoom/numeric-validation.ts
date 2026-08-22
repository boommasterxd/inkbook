export function requireFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite`);
  }
  return value;
}

export function requirePositive(value: number, name: string): number {
  requireFinite(value, name);
  if (value <= 0) {
    throw new RangeError(`${name} must be positive`);
  }
  return value;
}

export function requireNonNegative(value: number, name: string): number {
  requireFinite(value, name);
  if (value < 0) {
    throw new RangeError(`${name} must be non-negative`);
  }
  return value;
}
