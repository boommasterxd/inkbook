export const NOTE_COORDINATE_LIMIT = 10_000_000;
export const MIN_AREA_EXTENT = 0.01;
export type DataRecord = Record<string, unknown>;

export function closedRecord(
  value: unknown,
  keys: readonly string[],
  name: string,
): DataRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain data object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  const actual = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    actual.some((key) => typeof key !== "string") ||
    actual.length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError(`${name} is not a closed V1 record.`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError(
        `${name} may contain only enumerable data properties.`,
      );
    }
  }
  return Object.fromEntries(
    keys.map((key) => [key, (value as DataRecord)[key]]),
  );
}

export function closedValue<T extends string>(
  value: unknown,
  values: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new TypeError(`${name} has an unsupported value.`);
  }
  return value as T;
}

export function finiteNumber(
  value: unknown,
  name: string,
  minimum = -Infinity,
  maximum = Infinity,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(`${name} is outside its finite V1 range.`);
  }
  return value;
}

export function noteCoordinate(value: unknown, name: string): number {
  return finiteNumber(
    value,
    name,
    -NOTE_COORDINATE_LIMIT,
    NOTE_COORDINATE_LIMIT,
  );
}

export function notePoint(
  value: unknown,
  name: string,
): { readonly x: number; readonly y: number } {
  const data = closedRecord(value, ["x", "y"], name);
  return Object.freeze({
    x: noteCoordinate(data.x, `${name}.x`),
    y: noteCoordinate(data.y, `${name}.y`),
  });
}

export function canonicalRotation(value: unknown, name: string): number {
  const angle = finiteNumber(value, name);
  if (angle < -Math.PI || angle >= Math.PI) {
    throw new RangeError(`${name} must be canonical in [-PI, PI).`);
  }
  return angle;
}
