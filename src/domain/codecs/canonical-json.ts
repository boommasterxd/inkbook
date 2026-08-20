const MAX_JSON_NESTING = 64;
const LINE_FEED = 0x0a;
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;
const SORT_BEFORE = -1;

export type CanonicalJsonValue =
  | boolean
  | null
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export function canonicalizeJson(value: unknown): string {
  return serializeValue(value, new Set<object>(), 0);
}

export function encodeCanonicalJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalizeJson(value));
}

export function encodeCanonicalSidecarJson(value: unknown): Uint8Array {
  const canonicalBytes = encodeCanonicalJson(value);
  const sidecarBytes = new Uint8Array(canonicalBytes.byteLength + 1);
  sidecarBytes.set(canonicalBytes);
  sidecarBytes[sidecarBytes.length - 1] = LINE_FEED;
  return sidecarBytes;
}

function serializeValue(
  value: unknown,
  ancestors: Set<object>,
  nesting: number,
): string {
  if (value === null || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "string") {
    assertValidUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON numbers must be finite.");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError("The value is not representable as canonical JSON.");
  }
  if (nesting >= MAX_JSON_NESTING) {
    throw new RangeError("Canonical JSON nesting exceeds the limit of 64.");
  }
  if (ancestors.has(value)) {
    throw new TypeError("Canonical JSON cannot contain cyclic values.");
  }

  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? serializeArray(value, ancestors, nesting + 1)
      : serializeObject(value, ancestors, nesting + 1);
  } finally {
    ancestors.delete(value);
  }
}

function serializeArray(
  value: readonly unknown[],
  ancestors: Set<object>,
  nesting: number,
): string {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError("Canonical JSON arrays must be plain data arrays.");
  }
  const keys = ownDataKeys(value);
  if (
    keys.length !== value.length ||
    keys.some((key) => !isArrayIndex(key, value.length))
  ) {
    throw new TypeError(
      "Canonical JSON arrays must be dense and contain no extra properties.",
    );
  }
  return `[${value
    .map((item) => serializeValue(item, ancestors, nesting))
    .join(",")}]`;
}

function serializeObject(
  value: object,
  ancestors: Set<object>,
  nesting: number,
): string {
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Canonical JSON objects must be plain data objects.");
  }
  const record = value as Record<string, unknown>;
  const members = ownDataKeys(value)
    .sort(compareUtf16CodeUnits)
    .map((key) => {
      assertValidUnicode(key);
      return `${JSON.stringify(key)}:${serializeValue(record[key], ancestors, nesting)}`;
    });
  return `{${members.join(",")}}`;
}

function compareUtf16CodeUnits(left: string, right: string): number {
  if (left < right) return SORT_BEFORE;
  if (left > right) return 1;
  return 0;
}

function ownDataKeys(value: object): string[] {
  const keys = Reflect.ownKeys(value);
  const dataKeys: string[] = [];
  for (const key of keys) {
    if (Array.isArray(value) && key === "length") continue;
    if (typeof key !== "string") {
      throw new TypeError("Canonical JSON cannot contain symbol properties.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError(
        "Canonical JSON objects may contain only enumerable data properties.",
      );
    }
    dataKeys.push(key);
  }
  return dataKeys;
}

function isArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= HIGH_SURROGATE_MIN && codeUnit <= HIGH_SURROGATE_MAX) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= LOW_SURROGATE_MIN && following <= LOW_SURROGATE_MAX)) {
        throw new TypeError(
          "Canonical JSON strings must contain valid Unicode.",
        );
      }
      index += 1;
    } else if (codeUnit >= LOW_SURROGATE_MIN && codeUnit <= LOW_SURROGATE_MAX) {
      throw new TypeError("Canonical JSON strings must contain valid Unicode.");
    }
  }
}
