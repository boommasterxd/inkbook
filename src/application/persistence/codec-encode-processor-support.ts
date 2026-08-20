import {
  CANONICAL_JSON_PROCESS_MAX_UTF16_UNITS,
  createCanonicalJsonProcessor,
  type CanonicalJsonProcessor,
} from "../../domain/codecs";
import { PERSISTENCE_CODEC_CHUNK_UNITS_V1 } from "./codec-work";
import type { PersistenceEncodedElementChunkV1 } from "./element-chunk-cache";

const LINE_FEED_CODE = Number("10");
const COMMA_CODE = Number("44");
const HIGH_SURROGATE_MIN = Number("55296");
const HIGH_SURROGATE_MAX = Number("56319");
const LOW_SURROGATE_MIN = Number("56320");
const LOW_SURROGATE_MAX = Number("57343");
const LINE_FEED = new Uint8Array([LINE_FEED_CODE]);
const ELEMENT_SEPARATOR = new Uint8Array([COMMA_CODE]);

type Utf8Stage = "canonical" | "encode" | "allocate" | "copy" | "done";

export class CanonicalUtf8Processor {
  readonly #canonical: CanonicalJsonProcessor;
  readonly #encoder = new TextEncoder();
  #stage: Utf8Stage = "canonical";
  #textChunks: readonly string[] = [];
  #textIndex = 0;
  #textOffset = 0;
  #carry = "";
  #byteLength = 0;
  #byteParts: Uint8Array<ArrayBuffer>[] = [];
  #copyIndex = 0;
  #copyOffset = 0;
  #outputOffset = 0;
  #bytes: Uint8Array<ArrayBuffer> | null = null;

  constructor(value: unknown) {
    this.#canonical = createCanonicalJsonProcessor(value);
  }

  processNext(): boolean {
    switch (this.#stage) {
      case "canonical":
        return this.processCanonical();
      case "encode":
        return this.processUtf8();
      case "allocate":
        this.#bytes = new Uint8Array(this.#byteLength);
        this.#stage = "copy";
        return false;
      case "copy":
        return this.copyNext();
      case "done":
        return true;
    }
  }

  complete(): Uint8Array<ArrayBuffer> {
    if (this.#bytes === null || this.#stage !== "done") {
      throw new Error("Canonical UTF-8 encode is incomplete.");
    }
    return this.#bytes;
  }

  dispose(): void {
    this.#textChunks = [];
    this.#byteParts = [];
    this.#carry = "";
    this.#bytes = null;
  }

  private processCanonical(): boolean {
    if (!this.#canonical.processNext(CANONICAL_JSON_PROCESS_MAX_UTF16_UNITS)) {
      return false;
    }
    const chunks = this.#canonical.complete();
    if (chunks === undefined) throw new Error("Canonical JSON is incomplete.");
    this.#textChunks = chunks;
    this.#stage = "encode";
    return false;
  }

  private processUtf8(): boolean {
    const source = this.nextUtf8Source();
    if (source === null) {
      if (this.#carry !== "") throw new TypeError("Invalid Unicode boundary.");
      this.#stage = "allocate";
      return false;
    }
    const buffer = new Uint8Array(PERSISTENCE_CODEC_CHUNK_UNITS_V1);
    const encoded = this.#encoder.encodeInto(source.value, buffer);
    if (encoded.read === 0 && source.value.length > 0) {
      throw new Error("UTF-8 encoder made no progress.");
    }
    source.consume(encoded.read);
    if (encoded.written > 0) this.acceptBytes(buffer, encoded.written);
    return false;
  }

  private acceptBytes(buffer: Uint8Array<ArrayBuffer>, written: number): void {
    const part = buffer.slice(0, written);
    this.#byteParts.push(part);
    this.#byteLength += part.byteLength;
  }

  private nextUtf8Source(): Utf8Source | null {
    this.skipConsumedText();
    const chunk = this.#textChunks[this.#textIndex];
    if (this.#carry !== "") return this.sourceWithCarry(chunk);
    if (chunk === undefined) return null;
    const limit = Math.min(
      chunk.length,
      this.#textOffset + PERSISTENCE_CODEC_CHUNK_UNITS_V1,
    );
    let end = limit;
    if (isHighSurrogate(chunk.charCodeAt(end - 1))) end -= 1;
    if (end === this.#textOffset) {
      this.#carry = chunk[this.#textOffset] ?? "";
      this.#textOffset += 1;
      return this.nextUtf8Source();
    }
    return {
      value: chunk.slice(this.#textOffset, end),
      consume: (read): void => {
        this.#textOffset += read;
      },
    };
  }

  private sourceWithCarry(chunk: string | undefined): Utf8Source | null {
    if (chunk === undefined) return null;
    const low = chunk[this.#textOffset];
    if (low === undefined || !isLowSurrogate(low.charCodeAt(0))) {
      throw new TypeError("Invalid Unicode boundary.");
    }
    const value = `${this.#carry}${low}`;
    return {
      value,
      consume: (read): void => {
        if (read !== value.length) return;
        this.#carry = "";
        this.#textOffset += 1;
      },
    };
  }

  private skipConsumedText(): void {
    while (
      this.#textOffset >= (this.#textChunks[this.#textIndex]?.length ?? 0)
    ) {
      if (this.#textIndex >= this.#textChunks.length) return;
      this.#textIndex += 1;
      this.#textOffset = 0;
    }
  }

  private copyNext(): boolean {
    const bytes = this.#bytes;
    if (bytes === null) throw new Error("Missing canonical UTF-8 output.");
    const part = this.#byteParts[this.#copyIndex];
    if (part === undefined) return this.finishCopy();
    const length = Math.min(
      PERSISTENCE_CODEC_CHUNK_UNITS_V1,
      part.byteLength - this.#copyOffset,
    );
    bytes.set(
      part.subarray(this.#copyOffset, this.#copyOffset + length),
      this.#outputOffset,
    );
    this.#copyOffset += length;
    this.#outputOffset += length;
    if (this.#copyOffset === part.byteLength) {
      this.#copyIndex += 1;
      this.#copyOffset = 0;
    }
    return false;
  }

  private finishCopy(): boolean {
    this.#textChunks = [];
    this.#byteParts = [];
    this.#stage = "done";
    return true;
  }
}

interface Utf8Source {
  readonly value: string;
  readonly consume: (read: number) => void;
}

export class OutputAssembly {
  #output: Uint8Array<ArrayBuffer> | null = null;
  #pieces: Iterator<Uint8Array> | null = null;
  #piece: Uint8Array | null = null;
  #pieceOffset = 0;
  #outputOffset = 0;

  start(
    output: Uint8Array<ArrayBuffer>,
    scaffold: Uint8Array<ArrayBuffer>,
    markerOffset: number,
    markerLength: number,
    elements: readonly PersistenceEncodedElementChunkV1[],
  ): void {
    this.#output = output;
    this.#pieces = outputPieces(scaffold, markerOffset, markerLength, elements);
  }

  processNext(): boolean {
    const piece = this.currentPiece();
    if (piece === null) return true;
    const length = Math.min(
      PERSISTENCE_CODEC_CHUNK_UNITS_V1,
      piece.byteLength - this.#pieceOffset,
    );
    this.requiredOutput().set(
      piece.subarray(this.#pieceOffset, this.#pieceOffset + length),
      this.#outputOffset,
    );
    this.#pieceOffset += length;
    this.#outputOffset += length;
    if (this.#pieceOffset === piece.byteLength) this.finishPiece();
    return false;
  }

  dispose(): void {
    this.#output = null;
    this.#pieces = null;
    this.#piece = null;
  }

  private finishPiece(): void {
    this.#piece = null;
    this.#pieceOffset = 0;
  }

  private currentPiece(): Uint8Array | null {
    if (this.#piece !== null) return this.#piece;
    const next = this.#pieces?.next();
    if (next === undefined || next.done === true) return null;
    this.#piece = next.value;
    return next.value;
  }

  private requiredOutput(): Uint8Array<ArrayBuffer> {
    if (this.#output === null) throw new Error("Missing assembly output.");
    return this.#output;
  }
}

function* outputPieces(
  scaffold: Uint8Array<ArrayBuffer>,
  markerOffset: number,
  markerLength: number,
  elements: readonly PersistenceEncodedElementChunkV1[],
): Generator<Uint8Array> {
  yield scaffold.subarray(0, markerOffset);
  for (const [index, element] of elements.entries()) {
    if (index > 0) yield ELEMENT_SEPARATOR;
    yield element.bytes;
  }
  yield scaffold.subarray(markerOffset + markerLength);
  yield LINE_FEED;
}

export function bytesMatch(
  haystack: Uint8Array,
  needle: Uint8Array,
  offset: number,
): boolean {
  for (let index = 0; index < needle.length; index += 1) {
    if (haystack[offset + index] !== needle[index]) return false;
  }
  return true;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= HIGH_SURROGATE_MIN && codeUnit <= HIGH_SURROGATE_MAX;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= LOW_SURROGATE_MIN && codeUnit <= LOW_SURROGATE_MAX;
}
