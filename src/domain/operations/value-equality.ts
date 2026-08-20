const MAX_VALUE_DEPTH_V1 = 64;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function equalArrays(
  left: readonly unknown[],
  right: readonly unknown[],
  depth: number,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!equalValue(left[index], right[index], depth + 1)) return false;
  }
  return true;
}

function equalRecords(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
  depth: number,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (
      !Object.hasOwn(right, key) ||
      !equalValue(left[key], right[key], depth + 1)
    ) {
      return false;
    }
  }
  return true;
}

function equalValue(left: unknown, right: unknown, depth: number): boolean {
  if (Object.is(left, right)) return true;
  if (depth > MAX_VALUE_DEPTH_V1) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return equalArrays(left, right, depth);
  }
  if (isRecord(left) && isRecord(right)) {
    return equalRecords(left, right, depth);
  }
  return false;
}

export function canonicalValueEqualsV1(left: unknown, right: unknown): boolean {
  return equalValue(left, right, 0);
}

export function hasExactKeysV1(
  value: unknown,
  expectedKeys: readonly string[],
): value is Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Object.keys(value);
  if (keys.length !== expectedKeys.length) return false;
  return expectedKeys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor !== undefined && descriptor.enumerable && "value" in descriptor
    );
  });
}
