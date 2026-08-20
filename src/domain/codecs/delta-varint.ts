const COORDINATE_SCALE = 100;
const ABSOLUTE_COORDINATE_LIMIT = 10_000_000;
const ABSOLUTE_QUANTIZED_COORDINATE_LIMIT =
  ABSOLUTE_COORDINATE_LIMIT * COORDINATE_SCALE;
const PRESSURE_SCALE = 1_000;
const MAX_POINT_COUNT = 200_000;
const BYTES_PER_POINT_LIMIT = 20;
const MAX_VARINT_BYTES = 5;
const VARINT_PAYLOAD_BITS = 7;
const VARINT_PAYLOAD_MASK = 0x7f;
const VARINT_CONTINUATION = 0x80;
const MAX_FINAL_VARINT_PAYLOAD = 0x0f;
const UINT32_MAX = 0xffff_ffff;
const INT32_MIN = -0x8000_0000;
const INT32_MAX = 0x7fff_ffff;
const BINARY_RADIX = 2;
const BASE64_BLOCK_BYTES = 3;
const BASE64_SEXTET_BITS = 6;
const BYTE_BITS = 8;
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const ASCII_UPPER_A = "A".charCodeAt(0);
const ASCII_UPPER_Z = "Z".charCodeAt(0);
const ASCII_LOWER_A = "a".charCodeAt(0);
const ASCII_LOWER_Z = "z".charCodeAt(0);
const ASCII_ZERO = "0".charCodeAt(0);
const ASCII_NINE = "9".charCodeAt(0);
const LOWERCASE_OFFSET = 26;
const DIGIT_OFFSET = 52;
const HYPHEN_VALUE = 62;
const UNDERSCORE_VALUE = 63;
const FIRST_BYTE_SHIFT = 2;
const SECOND_BYTE_HIGH_SHIFT = 4;
const SECOND_BYTE_LOW_SHIFT = 4;
const THIRD_BYTE_HIGH_SHIFT = 2;
const LOW_TWO_BITS = 0x03;
const LOW_FOUR_BITS = 0x0f;
const LOW_SIX_BITS = 0x3f;
const BYTE_MASK = 0xff;
const REMAINDER_TWO = 2;
const ENCODED_STROKE_KEYS = [
  "codec",
  "data",
  "originXQ",
  "originYQ",
  "pointCount",
  "pressure",
] as const;
const SAMPLE_KEYS = ["elapsedMs", "x", "y"] as const;
const PRESSURE_SAMPLE_KEYS = ["elapsedMs", "pressure", "x", "y"] as const;

export type DeltaVarintPressureMode = "absent" | "present";

export interface DeltaVarintSampleV1 {
  readonly x: number;
  readonly y: number;
  readonly elapsedMs: number;
  readonly pressure?: number;
}

export interface EncodedStrokeV1 {
  readonly codec: "delta-varint-v1";
  readonly pointCount: number;
  readonly originXQ: number;
  readonly originYQ: number;
  readonly pressure: DeltaVarintPressureMode;
  readonly data: string;
}

export interface DecodedStrokeV1 {
  readonly pressure: DeltaVarintPressureMode;
  readonly points: readonly DeltaVarintSampleV1[];
}

export function encodeDeltaVarintStroke(
  samples: readonly DeltaVarintSampleV1[],
  pressure: DeltaVarintPressureMode,
): EncodedStrokeV1 {
  assertPressureMode(pressure);
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new RangeError("A stroke must contain at least one point.");
  }
  if (samples.length > MAX_POINT_COUNT) {
    throw new RangeError("The stroke point count exceeds the V1 limit.");
  }
  const inputSamples: readonly DeltaVarintSampleV1[] = samples;

  const first = validateSample(inputSamples[0], pressure);
  const originXQ = quantizeCoordinate(first.x);
  const originYQ = quantizeCoordinate(first.y);
  if (first.elapsedMs !== 0) {
    throw new RangeError("The first stroke timestamp must be zero.");
  }
  const bytes = new Uint8Array(inputSamples.length * BYTES_PER_POINT_LIMIT);
  let offset = 0;
  if (pressure === "present") {
    offset = writeVarint(bytes, offset, quantizePressure(first.pressure));
  }

  let previousXQ = originXQ;
  let previousYQ = originYQ;
  let previousElapsedMs = 0;
  for (let index = 1; index < inputSamples.length; index += 1) {
    const sample = validateSample(inputSamples[index], pressure);
    const xQ = quantizeCoordinate(sample.x);
    const yQ = quantizeCoordinate(sample.y);
    const xDelta = assertSignedInt32(xQ - previousXQ, "X delta");
    const yDelta = assertSignedInt32(yQ - previousYQ, "Y delta");
    const elapsedDelta = sample.elapsedMs - previousElapsedMs;
    assertUint32(elapsedDelta, "Timestamp delta");
    offset = writeVarint(bytes, offset, zigzagEncode(xDelta));
    offset = writeVarint(bytes, offset, zigzagEncode(yDelta));
    if (pressure === "present") {
      offset = writeVarint(bytes, offset, quantizePressure(sample.pressure));
    }
    offset = writeVarint(bytes, offset, elapsedDelta);
    previousXQ = xQ;
    previousYQ = yQ;
    previousElapsedMs = sample.elapsedMs;
  }

  return Object.freeze({
    codec: "delta-varint-v1",
    pointCount: inputSamples.length,
    originXQ,
    originYQ,
    pressure,
    data: encodeBase64Url(bytes.subarray(0, offset)),
  });
}

export function decodeDeltaVarintStroke(encoded: unknown): DecodedStrokeV1 {
  const record = validateEncodedStroke(encoded);
  const byteLimit = record.pointCount * BYTES_PER_POINT_LIMIT;
  const characterLimit = Math.ceil(
    byteLimit * (BYTE_BITS / BASE64_SEXTET_BITS),
  );
  if (record.data.length > characterLimit) {
    throw new RangeError("The compact stroke exceeds its encoded byte limit.");
  }
  const bytes = decodeBase64Url(record.data);
  if (bytes.byteLength > byteLimit) {
    throw new RangeError("The compact stroke exceeds its decoded byte limit.");
  }

  let offset = 0;
  let firstPressure: number | undefined;
  if (record.pressure === "present") {
    const decoded = readVarint(bytes, offset);
    offset = decoded.nextOffset;
    firstPressure = decodePressure(decoded.value);
  }
  const points: DeltaVarintSampleV1[] = [
    freezeSample(record.originXQ, record.originYQ, 0, firstPressure),
  ];
  let xQ = record.originXQ;
  let yQ = record.originYQ;
  let elapsedMs = 0;
  for (let index = 1; index < record.pointCount; index += 1) {
    const xDelta = readVarint(bytes, offset);
    const yDelta = readVarint(bytes, xDelta.nextOffset);
    offset = yDelta.nextOffset;
    let decodedPressure: number | undefined;
    if (record.pressure === "present") {
      const pressureValue = readVarint(bytes, offset);
      offset = pressureValue.nextOffset;
      decodedPressure = decodePressure(pressureValue.value);
    }
    const elapsedDelta = readVarint(bytes, offset);
    offset = elapsedDelta.nextOffset;
    xQ = assertQuantizedCoordinate(
      xQ + zigzagDecode(xDelta.value),
      "X coordinate",
    );
    yQ = assertQuantizedCoordinate(
      yQ + zigzagDecode(yDelta.value),
      "Y coordinate",
    );
    elapsedMs += elapsedDelta.value;
    assertUint32(elapsedMs, "Timestamp");
    points.push(freezeSample(xQ, yQ, elapsedMs, decodedPressure));
  }
  if (offset !== bytes.byteLength) {
    throw new RangeError("The compact stroke contains trailing bytes.");
  }
  return Object.freeze({
    pressure: record.pressure,
    points: Object.freeze(points),
  });
}

function validateSample(
  sample: DeltaVarintSampleV1 | undefined,
  pressure: DeltaVarintPressureMode,
): DeltaVarintSampleV1 {
  if (!isPlainObject(sample)) {
    throw new TypeError("Every stroke sample must be a plain data object.");
  }
  const expected = pressure === "present" ? PRESSURE_SAMPLE_KEYS : SAMPLE_KEYS;
  if (!hasExactKeys(sample, expected)) {
    throw new TypeError("A stroke sample does not match its pressure mode.");
  }
  if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y)) {
    throw new RangeError("Stroke coordinates must be finite.");
  }
  assertUint32(sample.elapsedMs, "Timestamp");
  if (pressure === "present" && !Number.isFinite(sample.pressure)) {
    throw new RangeError("Stroke pressure must be finite.");
  }
  return sample;
}

function validateEncodedStroke(encoded: unknown): EncodedStrokeV1 {
  if (!isPlainObject(encoded) || !hasExactKeys(encoded, ENCODED_STROKE_KEYS)) {
    throw new TypeError("The compact stroke record is not a closed V1 record.");
  }
  if (encoded.codec !== "delta-varint-v1") {
    throw new TypeError("The compact stroke codec is unsupported.");
  }
  assertPointCount(encoded.pointCount);
  assertQuantizedCoordinate(encoded.originXQ, "Origin X");
  assertQuantizedCoordinate(encoded.originYQ, "Origin Y");
  assertPressureMode(encoded.pressure);
  if (typeof encoded.data !== "string") {
    throw new TypeError("Compact stroke data must be a string.");
  }
  return encoded as unknown as EncodedStrokeV1;
}

function quantizeCoordinate(value: number): number {
  const quantized = Math.round(value * COORDINATE_SCALE);
  assertQuantizedCoordinate(quantized, "Quantized coordinate");
  return quantized === 0 ? 0 : quantized;
}

function quantizePressure(value: number | undefined): number {
  if (value === undefined) {
    throw new TypeError("Pressure is required for this stroke.");
  }
  return Math.round(Math.min(1, Math.max(0, value)) * PRESSURE_SCALE);
}

function decodePressure(value: number): number {
  if (value > PRESSURE_SCALE) {
    throw new RangeError("Decoded pressure exceeds the V1 range.");
  }
  return value / PRESSURE_SCALE;
}

function zigzagEncode(value: number): number {
  return value >= 0 ? BINARY_RADIX * value : BINARY_RADIX * Math.abs(value) - 1;
}

function zigzagDecode(value: number): number {
  return value % BINARY_RADIX === 0
    ? value / BINARY_RADIX
    : -(value + 1) / BINARY_RADIX;
}

function writeVarint(bytes: Uint8Array, offset: number, input: number): number {
  let value = input;
  do {
    const payload = value % VARINT_CONTINUATION;
    value = Math.floor(value / VARINT_CONTINUATION);
    bytes[offset] = payload | (value > 0 ? VARINT_CONTINUATION : 0);
    offset += 1;
  } while (value > 0);
  return offset;
}

function readVarint(
  bytes: Uint8Array,
  offset: number,
): { readonly value: number; readonly nextOffset: number } {
  let value = 0;
  for (let index = 0; index < MAX_VARINT_BYTES; index += 1) {
    const byte = bytes[offset + index];
    if (byte === undefined) {
      throw new RangeError("The compact stroke contains a truncated varint.");
    }
    const payload = byte & VARINT_PAYLOAD_MASK;
    if (index === MAX_VARINT_BYTES - 1 && payload > MAX_FINAL_VARINT_PAYLOAD) {
      throw new RangeError("The compact stroke varint overflows 32 bits.");
    }
    value += payload * BINARY_RADIX ** (VARINT_PAYLOAD_BITS * index);
    if ((byte & VARINT_CONTINUATION) === 0) {
      if (index > 0 && payload === 0) {
        throw new RangeError("The compact stroke varint is not minimal.");
      }
      return Object.freeze({ value, nextOffset: offset + index + 1 });
    }
  }
  throw new RangeError("The compact stroke varint exceeds five bytes.");
}

function encodeBase64Url(bytes: Uint8Array): string {
  let encoded = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_BLOCK_BYTES) {
    const first = bytes[offset] ?? 0;
    const second = bytes[offset + 1];
    const third = bytes[offset + REMAINDER_TWO];
    encoded += BASE64URL_ALPHABET.charAt(first >> FIRST_BYTE_SHIFT);
    encoded += BASE64URL_ALPHABET.charAt(
      ((first & LOW_TWO_BITS) << SECOND_BYTE_HIGH_SHIFT) |
        ((second ?? 0) >> SECOND_BYTE_LOW_SHIFT),
    );
    if (second !== undefined) {
      encoded += BASE64URL_ALPHABET.charAt(
        ((second & LOW_FOUR_BITS) << THIRD_BYTE_HIGH_SHIFT) |
          ((third ?? 0) >> BASE64_SEXTET_BITS),
      );
    }
    if (third !== undefined) {
      encoded += BASE64URL_ALPHABET.charAt(third & LOW_SIX_BITS);
    }
  }
  return encoded;
}

function decodeBase64Url(encoded: string): Uint8Array {
  const remainder = encoded.length % (BASE64_BLOCK_BYTES + 1);
  if (remainder === 1) {
    throw new RangeError("The compact stroke base64url length is invalid.");
  }
  const bytes = new Uint8Array(
    Math.floor((encoded.length * BASE64_SEXTET_BITS) / BYTE_BITS),
  );
  let accumulator = 0;
  let bitCount = 0;
  let outputOffset = 0;
  for (const character of encoded) {
    accumulator = accumulator * BINARY_RADIX ** BASE64_SEXTET_BITS;
    accumulator += decodeSextet(character);
    bitCount += BASE64_SEXTET_BITS;
    if (bitCount >= BYTE_BITS) {
      bitCount -= BYTE_BITS;
      bytes[outputOffset] =
        Math.floor(accumulator / BINARY_RADIX ** bitCount) & BYTE_MASK;
      outputOffset += 1;
      accumulator %= BINARY_RADIX ** bitCount;
    }
  }
  if (accumulator !== 0) {
    throw new RangeError("The compact stroke base64url tail is not canonical.");
  }
  return bytes;
}

function decodeSextet(character: string): number {
  const code = character.charCodeAt(0);
  if (code >= ASCII_UPPER_A && code <= ASCII_UPPER_Z)
    return code - ASCII_UPPER_A;
  if (code >= ASCII_LOWER_A && code <= ASCII_LOWER_Z) {
    return code - ASCII_LOWER_A + LOWERCASE_OFFSET;
  }
  if (code >= ASCII_ZERO && code <= ASCII_NINE) {
    return code - ASCII_ZERO + DIGIT_OFFSET;
  }
  if (character === "-") return HYPHEN_VALUE;
  if (character === "_") return UNDERSCORE_VALUE;
  throw new RangeError("The compact stroke base64url alphabet is invalid.");
}

function freezeSample(
  xQ: number,
  yQ: number,
  elapsedMs: number,
  pressure: number | undefined,
): DeltaVarintSampleV1 {
  const coordinates = { x: xQ / COORDINATE_SCALE, y: yQ / COORDINATE_SCALE };
  return Object.freeze(
    pressure === undefined
      ? { ...coordinates, elapsedMs }
      : { ...coordinates, elapsedMs, pressure },
  );
}

function assertPointCount(value: unknown): asserts value is number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_POINT_COUNT
  ) {
    throw new RangeError(
      "The compact stroke point count is outside the V1 range.",
    );
  }
}

function assertPressureMode(
  value: unknown,
): asserts value is DeltaVarintPressureMode {
  if (value !== "absent" && value !== "present") {
    throw new TypeError("The compact stroke pressure mode is invalid.");
  }
}

function assertSignedInt32(value: unknown, name: string): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < INT32_MIN ||
    (value as number) > INT32_MAX
  ) {
    throw new RangeError(`${name} must be a signed 32-bit integer.`);
  }
  return value as number;
}

function assertQuantizedCoordinate(value: unknown, name: string): number {
  const coordinate = assertSignedInt32(value, name);
  if (Math.abs(coordinate) > ABSOLUTE_QUANTIZED_COORDINATE_LIMIT) {
    throw new RangeError(`${name} exceeds the absolute coordinate limit.`);
  }
  return coordinate;
}

function assertUint32(value: unknown, name: string): asserts value is number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 0 ||
    (value as number) > UINT32_MAX
  ) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer.`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  const stringKeys = keys as string[];
  if (stringKeys.length !== expected.length) return false;
  return expected.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      stringKeys.includes(key) &&
      descriptor?.enumerable === true &&
      "value" in descriptor
    );
  });
}
