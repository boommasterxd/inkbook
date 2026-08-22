const UTF8_ENCODER = new TextEncoder();

export function encodedByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

export class EncodedByteBudget {
  #usedBytes: number;

  public constructor(
    readonly maximumBytes: number,
    initialBytes = 0,
  ) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
      throw new RangeError("Encoded byte budget must be a non-negative safe integer.");
    }
    if (!Number.isSafeInteger(initialBytes) || initialBytes < 0 || initialBytes > maximumBytes) {
      throw new RangeError("Encoded byte budget initial usage is invalid.");
    }
    this.#usedBytes = initialBytes;
  }

  public get usedBytes(): number {
    return this.#usedBytes;
  }

  public tryReserve(bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return false;
    if (this.#usedBytes + bytes > this.maximumBytes) return false;
    this.#usedBytes += bytes;
    return true;
  }
}
