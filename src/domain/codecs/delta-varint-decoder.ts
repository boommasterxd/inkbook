import type {
  DecodedStrokeV1,
  DeltaVarintPressureMode,
  DeltaVarintSampleV1,
  EncodedStrokeV1,
} from "./delta-varint";

const COORDINATE_SCALE = 100;
const ABSOLUTE_QUANTIZED_COORDINATE_LIMIT = 1_000_000_000;
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
const BYTE_MASK = 0xff;
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const ENCODED_STROKE_KEYS = [
  "codec",
  "data",
  "originXQ",
  "originYQ",
  "pointCount",
  "pressure",
] as const;

export const DELTA_VARINT_DECODE_MAX_UNITS_V1 = 16_384;

export interface DeltaVarintDecodeProcessorV1 {
  readonly done: boolean;
  processNext(maxUnits?: number): boolean;
  complete(): DecodedStrokeV1 | undefined;
  dispose(): void;
}

export interface DeltaVarintValidationProcessorV1 {
  readonly done: boolean;
  processNext(maxUnits?: number): boolean;
  complete(): ValidatedDeltaVarintStrokeV1 | undefined;
  dispose(): void;
}

const VALIDATED_DELTA_VARINT_STROKE_V1 = Symbol(
  "validated-delta-varint-stroke-v1",
);

export interface ValidatedDeltaVarintStrokeV1 {
  readonly encoded: EncodedStrokeV1;
  readonly [VALIDATED_DELTA_VARINT_STROKE_V1]: true;
}

type Phase = "base64" | "first-point" | "points" | "finish" | "done";

export function createDeltaVarintDecodeProcessorV1(
  encoded: unknown,
): DeltaVarintDecodeProcessorV1 {
  return new DeltaVarintDecodeProcessor(validateEncodedStroke(encoded), true);
}

export function createDeltaVarintValidationProcessorV1(
  encoded: unknown,
): DeltaVarintValidationProcessorV1 {
  const processor = new DeltaVarintDecodeProcessor(
    validateEncodedStroke(encoded),
    false,
  );
  return Object.freeze({
    get done(): boolean {
      return processor.done;
    },
    processNext(maxUnits?: number): boolean {
      return processor.processNext(maxUnits);
    },
    complete(): ValidatedDeltaVarintStrokeV1 | undefined {
      return processor.completeValidation();
    },
    dispose(): void {
      processor.dispose();
    },
  });
}

class DeltaVarintDecodeProcessor implements DeltaVarintDecodeProcessorV1 {
  readonly #record: EncodedStrokeV1;
  #phase: Phase = "base64";
  #bytes: Uint8Array | undefined;
  #characterOffset = 0;
  #outputOffset = 0;
  #accumulator = 0;
  #bitCount = 0;
  #byteOffset = 0;
  #pointIndex = 0;
  #xQ = 0;
  #yQ = 0;
  #elapsedMs = 0;
  #points: DeltaVarintSampleV1[] = [];
  #result: DecodedStrokeV1 | undefined;
  #validation: ValidatedDeltaVarintStrokeV1 | undefined;
  #disposed = false;

  constructor(
    record: EncodedStrokeV1,
    private readonly retainPoints: boolean,
  ) {
    this.#record = record;
    const byteLimit = record.pointCount * BYTES_PER_POINT_LIMIT;
    const characterLimit = Math.ceil(
      byteLimit * (BYTE_BITS / BASE64_SEXTET_BITS),
    );
    if (record.data.length > characterLimit) {
      throw new RangeError(
        "The compact stroke exceeds its encoded byte limit.",
      );
    }
    if (record.data.length % (BASE64_BLOCK_BYTES + 1) === 1) {
      throw new RangeError("The compact stroke base64url length is invalid.");
    }
    this.#bytes = new Uint8Array(
      Math.floor((record.data.length * BASE64_SEXTET_BITS) / BYTE_BITS),
    );
  }

  get done(): boolean {
    return this.#phase === "done";
  }

  processNext(maxUnits = DELTA_VARINT_DECODE_MAX_UNITS_V1): boolean {
    this.assertUsable();
    assertProcessLimit(maxUnits);
    if (this.done) return true;
    switch (this.#phase) {
      case "base64":
        this.decodeBase64(maxUnits);
        break;
      case "first-point":
        this.decodeFirstPoint();
        break;
      case "points":
        this.decodePoints(maxUnits);
        break;
      case "finish":
        this.finish();
        break;
      case "done":
        return true;
    }
    return this.done;
  }

  complete(): DecodedStrokeV1 | undefined {
    this.assertUsable();
    return this.#result;
  }

  completeValidation(): ValidatedDeltaVarintStrokeV1 | undefined {
    this.assertUsable();
    return this.#validation;
  }

  dispose(): void {
    this.#disposed = true;
    this.#bytes = undefined;
    this.#points = [];
    this.#result = undefined;
    this.#validation = undefined;
  }

  private decodeBase64(maxUnits: number): void {
    const end = Math.min(
      this.#record.data.length,
      this.#characterOffset + maxUnits,
    );
    const bytes = this.bytes();
    while (this.#characterOffset < end) {
      const character = this.#record.data.charAt(this.#characterOffset);
      this.#accumulator *= BINARY_RADIX ** BASE64_SEXTET_BITS;
      this.#accumulator += decodeSextet(character);
      this.#bitCount += BASE64_SEXTET_BITS;
      if (this.#bitCount >= BYTE_BITS) {
        this.#bitCount -= BYTE_BITS;
        bytes[this.#outputOffset] =
          Math.floor(this.#accumulator / BINARY_RADIX ** this.#bitCount) &
          BYTE_MASK;
        this.#outputOffset += 1;
        this.#accumulator %= BINARY_RADIX ** this.#bitCount;
      }
      this.#characterOffset += 1;
    }
    if (this.#characterOffset < this.#record.data.length) return;
    if (this.#accumulator !== 0) {
      throw new RangeError(
        "The compact stroke base64url tail is not canonical.",
      );
    }
    if (this.#outputOffset > this.#record.pointCount * BYTES_PER_POINT_LIMIT) {
      throw new RangeError(
        "The compact stroke exceeds its decoded byte limit.",
      );
    }
    this.#phase = "first-point";
  }

  private decodeFirstPoint(): void {
    let pressure: number | undefined;
    if (this.#record.pressure === "present") {
      const decoded = readVarint(this.bytes(), this.#byteOffset);
      this.#byteOffset = decoded.nextOffset;
      pressure = decodePressure(decoded.value);
    }
    this.#xQ = this.#record.originXQ;
    this.#yQ = this.#record.originYQ;
    if (this.retainPoints) {
      this.#points.push(freezeSample(this.#xQ, this.#yQ, 0, pressure));
    }
    this.#pointIndex = 1;
    this.#phase = "points";
  }

  private decodePoints(maxUnits: number): void {
    const end = Math.min(this.#record.pointCount, this.#pointIndex + maxUnits);
    while (this.#pointIndex < end) this.decodePoint();
    if (this.#pointIndex >= this.#record.pointCount) this.#phase = "finish";
  }

  private decodePoint(): void {
    const bytes = this.bytes();
    const xDelta = readVarint(bytes, this.#byteOffset);
    const yDelta = readVarint(bytes, xDelta.nextOffset);
    this.#byteOffset = yDelta.nextOffset;
    let pressure: number | undefined;
    if (this.#record.pressure === "present") {
      const pressureValue = readVarint(bytes, this.#byteOffset);
      this.#byteOffset = pressureValue.nextOffset;
      pressure = decodePressure(pressureValue.value);
    }
    const elapsedDelta = readVarint(bytes, this.#byteOffset);
    this.#byteOffset = elapsedDelta.nextOffset;
    this.#xQ = assertQuantizedCoordinate(
      this.#xQ + zigzagDecode(xDelta.value),
      "X coordinate",
    );
    this.#yQ = assertQuantizedCoordinate(
      this.#yQ + zigzagDecode(yDelta.value),
      "Y coordinate",
    );
    this.#elapsedMs += elapsedDelta.value;
    assertUint32(this.#elapsedMs, "Timestamp");
    if (this.retainPoints) {
      this.#points.push(
        freezeSample(this.#xQ, this.#yQ, this.#elapsedMs, pressure),
      );
    }
    this.#pointIndex += 1;
  }

  private finish(): void {
    if (this.#byteOffset !== this.#outputOffset) {
      throw new RangeError("The compact stroke contains trailing bytes.");
    }
    if (this.retainPoints) {
      this.#result = Object.freeze({
        pressure: this.#record.pressure,
        points: Object.freeze(this.#points),
      });
    } else {
      const validation: ValidatedDeltaVarintStrokeV1 = {
        encoded: this.#record,
        [VALIDATED_DELTA_VARINT_STROKE_V1]: true,
      };
      this.#validation = Object.freeze(validation);
    }
    this.#phase = "done";
  }

  private bytes(): Uint8Array {
    const bytes = this.#bytes;
    if (bytes === undefined) throw new Error("Stroke decoder is disposed.");
    return bytes;
  }

  private assertUsable(): void {
    if (this.#disposed) throw new Error("Stroke decoder is disposed.");
  }
}

function validateEncodedStroke(encoded: unknown): EncodedStrokeV1 {
  if (!isPlainObject(encoded) || !hasExactKeys(encoded, ENCODED_STROKE_KEYS)) {
    throw new TypeError("The compact stroke record is not a closed V1 record.");
  }
  if (encoded.codec !== "delta-varint-v1") {
    throw new TypeError("The compact stroke codec is unsupported.");
  }
  const pointCount = encoded.pointCount;
  assertPointCount(pointCount);
  const originXQ = assertQuantizedCoordinate(encoded.originXQ, "Origin X");
  const originYQ = assertQuantizedCoordinate(encoded.originYQ, "Origin Y");
  assertPressureMode(encoded.pressure);
  const pressure = encoded.pressure;
  if (typeof encoded.data !== "string") {
    throw new TypeError("Compact stroke data must be a string.");
  }
  return Object.freeze({
    codec: encoded.codec,
    pointCount,
    originXQ,
    originYQ,
    pressure,
    data: encoded.data,
  });
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

function decodeSextet(character: string): number {
  const value = BASE64URL_ALPHABET.indexOf(character);
  if (value < 0) {
    throw new RangeError("The compact stroke base64url alphabet is invalid.");
  }
  return value;
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

function decodePressure(value: number): number {
  if (value > PRESSURE_SCALE) {
    throw new RangeError("Decoded pressure exceeds the V1 range.");
  }
  return value / PRESSURE_SCALE;
}

function zigzagDecode(value: number): number {
  return value % BINARY_RADIX === 0
    ? value / BINARY_RADIX
    : -(value + 1) / BINARY_RADIX;
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

function assertQuantizedCoordinate(value: unknown, name: string): number {
  const coordinate = assertSignedInt32(value, name);
  if (Math.abs(coordinate) > ABSOLUTE_QUANTIZED_COORDINATE_LIMIT) {
    throw new RangeError(`${name} exceeds the absolute coordinate limit.`);
  }
  return coordinate;
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

function assertUint32(value: unknown, name: string): asserts value is number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 0 ||
    (value as number) > UINT32_MAX
  ) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer.`);
  }
}

function assertProcessLimit(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > DELTA_VARINT_DECODE_MAX_UNITS_V1
  ) {
    throw new RangeError("Stroke decode work units are outside the V1 limit.");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
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
