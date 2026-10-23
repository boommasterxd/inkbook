const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const decoder = new TextDecoder();
const COPY_CHUNK_BYTES = 64 * 1024;

abstract class Base64ChunkWriter {
  #word = 0;
  #bytes = 0;
  readonly #chunk = new Uint8Array(256);
  #length = 0;

  public append(value: number): void {
    this.#word = this.#word * 256 + value;
    this.#bytes += 1;
    if (this.#bytes !== 3) return;
    this.#encodeWord(this.#word);
    this.#word = 0;
    this.#bytes = 0;
  }

  protected finishChunks(): void {
    if (this.#bytes === 1) {
      this.#encodeWord(this.#word * 65536, 2);
    } else if (this.#bytes === 2) {
      this.#encodeWord(this.#word * 256, 1);
    }
    this.#flush();
  }

  protected abstract retainChunk(bytes: Uint8Array<ArrayBuffer>): void;

  #encodeWord(word: number, padding = 0): void {
    this.#chunk[this.#length++] = ALPHABET.charCodeAt((word >>> 18) & 63);
    this.#chunk[this.#length++] = ALPHABET.charCodeAt((word >>> 12) & 63);
    this.#chunk[this.#length++] = padding === 2 ? 61 : ALPHABET.charCodeAt((word >>> 6) & 63);
    this.#chunk[this.#length++] = padding > 0 ? 61 : ALPHABET.charCodeAt(word & 63);
    if (this.#length === this.#chunk.length) this.#flush();
  }

  #flush(): void {
    if (this.#length === 0) return;
    const bytes =
      this.#length === this.#chunk.length ? this.#chunk : this.#chunk.subarray(0, this.#length);
    this.retainChunk(bytes);
    this.#length = 0;
  }
}

export class SampleBase64Writer extends Base64ChunkWriter {
  readonly #parts: string[] = [];

  protected retainChunk(bytes: Uint8Array<ArrayBuffer>): void {
    this.#parts.push(decoder.decode(bytes));
  }

  public finish(): string {
    this.finishChunks();
    return this.#parts.join("");
  }
}

/** Retains exact ASCII chunks without converting their bytes through JavaScript strings. */
export class SampleBase64ByteWriter extends Base64ChunkWriter {
  readonly #parts: Uint8Array<ArrayBuffer>[] = [];
  #length = 0;

  protected retainChunk(bytes: Uint8Array<ArrayBuffer>): void {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    this.#parts.push(copy);
    this.#length += copy.byteLength;
  }

  public finish(): Uint8Array<ArrayBuffer> {
    const steps = this.finishSteps();
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
  }

  /** Preserve metadata's byte-copy checkpoints without requiring a task handoff. */
  public *finishSteps(signal?: AbortSignal): Generator<void, Uint8Array<ArrayBuffer>> {
    signal?.throwIfAborted();
    this.finishChunks();
    if (this.#parts.length === 1) return this.#parts[0]!;
    const bytes = new Uint8Array(this.#length);
    let offset = 0;
    let copied = 0;
    for (const part of this.#parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
      copied += part.byteLength;
      if (copied >= COPY_CHUNK_BYTES && offset < bytes.byteLength) {
        yield;
        signal?.throwIfAborted();
        copied = 0;
      }
    }
    return bytes;
  }
}

/** Reads canonical Base64 without allocating a decoded byte buffer. */
export class SampleBase64Reader {
  readonly byteLength: number;
  #position = 0;
  #word = 0;
  #bytes = 0;
  #readBytes = 0;
  readonly #padding: number;

  public constructor(readonly input: string) {
    if (input.length === 0 || input.length % 4 !== 0) this.#invalid();
    const padding = input.endsWith("==") ? 2 : input.endsWith("=") ? 1 : 0;
    this.#padding = padding;
    const finalValue = this.#digit(input.length - padding - 1);
    if ((padding === 2 && (finalValue & 15) !== 0) || (padding === 1 && (finalValue & 3) !== 0)) {
      this.#invalid();
    }
    this.byteLength = (input.length / 4) * 3 - padding;
  }

  public read(): number {
    if (this.#readBytes >= this.byteLength) this.#invalid();
    if (this.#bytes === 0) this.#readWord();
    this.#bytes -= 1;
    this.#readBytes += 1;
    return (this.#word >>> (this.#bytes * 8)) & 255;
  }

  public get remainingBytes(): number {
    return this.byteLength - this.#readBytes;
  }

  #readWord(): void {
    this.#word = 0;
    for (let index = 0; index < 4; index += 1) {
      const position = this.#position++;
      const isPadding =
        this.input[position] === "=" && position >= this.input.length - this.#padding;
      this.#word = this.#word * 64 + (isPadding ? 0 : this.#digit(position));
    }
    this.#bytes = 3;
  }

  #digit(position: number): number {
    const character = this.input[position];
    const code = character?.charCodeAt(0) ?? -1;
    if (code >= 65 && code <= 90) return code - 65;
    if (code >= 97 && code <= 122) return code - 71;
    if (code >= 48 && code <= 57) return code + 4;
    if (character === "+") return 62;
    if (character === "/") return 63;
    return this.#invalid();
  }

  #invalid(): never {
    throw new RangeError("Invalid compact stroke Base64.");
  }
}
