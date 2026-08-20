import {
  CANONICAL_JSON_PROCESS_MAX_UTF16_UNITS,
  createCanonicalJsonProcessor,
} from "./canonical-json";

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const OMIT_LAST_UNIT = -1;
const LAST_UNIT = -1;
const LAST_INDEX_OFFSET = 1;

export interface CanonicalJsonByteCounterV1 {
  readonly done: boolean;
  readonly utf8Bytes: number;
  processNext(): boolean;
}

export function createCanonicalJsonByteCounterV1(
  value: unknown,
  maximumUtf8Bytes: number,
): CanonicalJsonByteCounterV1 {
  return new CanonicalByteCounter(value, maximumUtf8Bytes);
}

class CanonicalByteCounter implements CanonicalJsonByteCounterV1 {
  readonly #canonical;
  readonly #textEncoder = new TextEncoder();
  #chunkIndex = 0;
  #pendingHighSurrogate = "";
  #utf8Bytes = 0;

  constructor(
    value: unknown,
    private readonly maximumUtf8Bytes: number,
  ) {
    this.#canonical = createCanonicalJsonProcessor(value);
  }

  get done(): boolean {
    return this.#canonical.done;
  }

  get utf8Bytes(): number {
    return this.#utf8Bytes;
  }

  processNext(): boolean {
    this.#canonical.processNext(CANONICAL_JSON_PROCESS_MAX_UTF16_UNITS);
    const chunk = this.#canonical.chunkAt(this.#chunkIndex);
    if (chunk !== undefined) {
      this.#chunkIndex += 1;
      this.countChunk(chunk, this.#canonical.done);
    }
    if (this.#canonical.done && this.#pendingHighSurrogate.length > 0) {
      this.addBytes(this.#pendingHighSurrogate);
      this.#pendingHighSurrogate = "";
    }
    return this.done;
  }

  private countChunk(chunk: string, final: boolean): void {
    const input = this.#pendingHighSurrogate + chunk;
    this.#pendingHighSurrogate = "";
    const last = input.charCodeAt(input.length - LAST_INDEX_OFFSET);
    const endsWithHighSurrogate =
      !final && last >= HIGH_SURROGATE_MIN && last <= HIGH_SURROGATE_MAX;
    const measurable = endsWithHighSurrogate
      ? input.slice(0, OMIT_LAST_UNIT)
      : input;
    if (endsWithHighSurrogate) {
      this.#pendingHighSurrogate = input.slice(LAST_UNIT);
    }
    this.addBytes(measurable);
  }

  private addBytes(value: string): void {
    this.#utf8Bytes += this.#textEncoder.encode(value).byteLength;
    if (this.#utf8Bytes > this.maximumUtf8Bytes) {
      throw new RangeError("Serialized scene exceeds the V1 UTF-8 limit.");
    }
  }
}
