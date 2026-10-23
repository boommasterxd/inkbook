const ALLOWED_ENTITIES = Object.freeze([
  { encoded: "&amp;", value: "&" },
  { encoded: "&lt;", value: "<" },
  { encoded: "&gt;", value: ">" },
]);
const DECODED_CHUNK_CHARACTERS = 64 * 1024;
const METADATA_CLOSE = "</metadata>";

export interface CompleteStreamingSvgMetadata {
  readonly kind: "complete";
  readonly metadataBytes: number;
  readonly metadataText: string;
  readonly trailing: string;
}

export type StreamingSvgMetadataResult =
  { readonly kind: "collecting" } | CompleteStreamingSvgMetadata | { readonly kind: "invalid" };

/** Retains decoded JSON only; raw XML and delimiter fragments remain bounded to the input slice. */
export class StreamingSvgMetadataParser {
  readonly #encoder = new TextEncoder();
  readonly #maximumBytes: number;
  readonly #decodedChunks: string[] = [];
  readonly #decodedParts: string[] = [];
  #closingCarry = "";
  #decodedBytes = 0;
  #decodedPartCharacters = 0;
  #entityCarry = "";
  #rawBytes = 0;
  #state: "collecting" | "complete" | "invalid" = "collecting";

  public constructor(maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
      throw new RangeError("maximumBytes must be a non-negative safe integer.");
    }
    this.#maximumBytes = maximumBytes;
  }

  public consume(input: string): StreamingSvgMetadataResult {
    if (this.#state !== "collecting") {
      throw new Error("Streaming SVG metadata is no longer accepting input.");
    }
    const combined = this.#closingCarry + input;
    const close = combined.indexOf(METADATA_CLOSE);
    if (close >= 0) {
      if (!this.#consumeRaw(combined.slice(0, close)) || this.#entityCarry.length > 0) {
        return this.#invalidate();
      }
      this.#state = "complete";
      this.#flushDecodedParts();
      const metadataText = this.#decodedChunks.join("");
      this.#releaseDecodedChunks();
      this.#closingCarry = "";
      return {
        kind: "complete",
        metadataBytes: this.#decodedBytes,
        metadataText,
        trailing: combined.slice(close + METADATA_CLOSE.length),
      };
    }

    const carryLength = closingPrefixLength(combined);
    const rawEnd = combined.length - carryLength;
    if (!this.#consumeRaw(combined.slice(0, rawEnd))) return this.#invalidate();
    this.#closingCarry = combined.slice(rawEnd);
    return { kind: "collecting" };
  }

  public release(): void {
    this.#releaseDecodedChunks();
    this.#closingCarry = "";
    this.#entityCarry = "";
  }

  #consumeRaw(input: string): boolean {
    const inputBytes = this.#encoder.encode(input).byteLength;
    if (this.#rawBytes + inputBytes > this.#maximumBytes) return false;
    this.#rawBytes += inputBytes;

    const combined = this.#entityCarry + input;
    this.#entityCarry = "";
    let cursor = 0;
    let literalStart = 0;
    while (cursor < combined.length) {
      const character = combined[cursor];
      if (character === "<") return false;
      if (character !== "&") {
        cursor += 1;
        continue;
      }
      if (!this.#appendDecoded(combined.slice(literalStart, cursor))) return false;
      const entity = matchAllowedEntity(combined, cursor);
      if (entity.kind === "partial") {
        this.#entityCarry = combined.slice(cursor);
        return true;
      }
      if (entity.kind === "invalid" || !this.#appendDecoded(entity.value)) return false;
      cursor += entity.length;
      literalStart = cursor;
    }
    return this.#appendDecoded(combined.slice(literalStart));
  }

  #appendDecoded(value: string): boolean {
    if (value.length === 0) return true;
    const valueBytes = this.#encoder.encode(value).byteLength;
    if (this.#decodedBytes + valueBytes > this.#maximumBytes) return false;
    this.#decodedBytes += valueBytes;
    this.#decodedParts.push(value);
    this.#decodedPartCharacters += value.length;
    if (this.#decodedPartCharacters >= DECODED_CHUNK_CHARACTERS) this.#flushDecodedParts();
    return true;
  }

  #flushDecodedParts(): void {
    if (this.#decodedParts.length === 0) return;
    this.#decodedChunks.push(this.#decodedParts.join(""));
    this.#decodedParts.length = 0;
    this.#decodedPartCharacters = 0;
  }

  #invalidate(): StreamingSvgMetadataResult {
    this.#state = "invalid";
    this.release();
    return { kind: "invalid" };
  }

  #releaseDecodedChunks(): void {
    this.#decodedChunks.length = 0;
    this.#decodedParts.length = 0;
    this.#decodedPartCharacters = 0;
  }
}

function closingPrefixLength(input: string): number {
  const maximum = Math.min(input.length, METADATA_CLOSE.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    if (METADATA_CLOSE.startsWith(input.slice(input.length - length))) return length;
  }
  return 0;
}

function matchAllowedEntity(
  input: string,
  start: number,
):
  | { readonly kind: "complete"; readonly length: number; readonly value: string }
  | { readonly kind: "invalid" }
  | { readonly kind: "partial" } {
  for (const entity of ALLOWED_ENTITIES) {
    if (input.startsWith(entity.encoded, start)) {
      return { kind: "complete", length: entity.encoded.length, value: entity.value };
    }
  }
  const remainder = input.slice(start);
  return ALLOWED_ENTITIES.some((entity) => entity.encoded.startsWith(remainder))
    ? { kind: "partial" }
    : { kind: "invalid" };
}
