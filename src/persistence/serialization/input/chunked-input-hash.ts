import { ChunkedSha256 } from "../chunked-output-sha256";
import {
  assembleAndHashPreparedUtf8Output,
  hashExactUtf8Output,
  MAX_NATIVE_HASH_BYTES,
} from "../output/chunked-output-assembler";
import type { ChunkedInkbookInputOptions } from "./chunked-input-types";
import { combineInputBytes } from "./chunked-input-utils";
import { SafeStaticProof } from "./safe-static-proof";
import type { DocumentHashPort } from "../sha256";
import type { ChunkedInputCheckpoint } from "./chunked-input-types";

export function copyAndHashInputBytes(
  input: Uint8Array,
  options: Pick<ChunkedInkbookInputOptions, "checkpoint" | "signal">,
  sliceByteLimit: number,
) {
  return assembleAndHashPreparedUtf8Output([input], input.byteLength, {
    ...options,
    maximumBytes: MAX_NATIVE_HASH_BYTES,
    sliceByteLimit,
  });
}

/** Owns decoded bytes; bounded runtime and export inputs may retain a terminal-digest buffer. */
export class ChunkedInputHash {
  readonly #hasher: DocumentHashPort | undefined;
  readonly #signal: AbortSignal | undefined;
  readonly #checkpoint: ChunkedInputCheckpoint | undefined;
  readonly #incremental = new ChunkedSha256();
  readonly #chunks: Uint8Array[] = [];
  #output: Uint8Array<ArrayBuffer> | undefined;
  #confirmedHash: string | undefined;
  #bytes = 0;
  #writing = false;

  public constructor(options: ChunkedInkbookInputOptions) {
    this.#hasher = options.hasher;
    this.#signal = options.signal;
    this.#checkpoint = options.checkpoint;
    const proof = options.safeStaticProof;
    if (proof !== undefined && !SafeStaticProof.isAuthentic(proof)) {
      throw new TypeError("Safe SVG proof must come from an owned validation producer.");
    }
    if (proof !== undefined && this.#hasher !== undefined) {
      throw new TypeError("Safe SVG proof requires hashing the complete actual input bytes.");
    }
    const inputBytes = options.nativeInputBytes;
    const runtimeInput =
      inputBytes !== undefined && Number.isSafeInteger(inputBytes) && inputBytes >= 0;
    const totalBytes = runtimeInput ? inputBytes : proof?.totalBytes;
    const exportInput =
      options.nativeExportHash === true &&
      options.onValidatedSnapshot === undefined &&
      options.sampleEncodingCache === undefined;
    if (
      (runtimeInput || exportInput) &&
      options.staticValidation === "safe" &&
      this.#hasher === undefined &&
      totalBytes !== undefined &&
      totalBytes <= MAX_NATIVE_HASH_BYTES &&
      typeof crypto !== "undefined" &&
      crypto.subtle !== undefined
    ) {
      this.#output = new Uint8Array(totalBytes);
    }
  }

  /** Only consecutive ranges of the privately hashed allocation may be consumed after a hit. */
  public async bindWorkerPreview(input: Uint8Array, proof: SafeStaticProof, chunkBytes: number) {
    const assembly = await copyAndHashInputBytes(
      input,
      {
        ...(this.#checkpoint === undefined ? {} : { checkpoint: this.#checkpoint }),
        ...(this.#signal === undefined ? {} : { signal: this.#signal }),
      },
      chunkBytes,
    );
    this.#signal?.throwIfAborted();
    if (!proof.matches(assembly.hash, assembly.totalBytes)) return undefined;
    this.#output = assembly.output;
    this.#confirmedHash = assembly.hash;
    return this.#output;
  }

  public get writePending(): boolean {
    return this.#writing;
  }

  public beginWrite(): boolean {
    if (this.#output === undefined) return true;
    if (this.#writing) return false;
    this.#writing = true;
    return true;
  }

  public endWrite(): void {
    this.#writing = false;
  }

  public get retainedBytes(): number {
    return (
      this.#output?.byteLength ?? this.#chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
    );
  }

  public copy(chunk: Uint8Array): Uint8Array | undefined {
    let owned: Uint8Array;
    if (this.#output === undefined) owned = new Uint8Array(chunk);
    else {
      if (chunk.byteLength > this.#output.byteLength - this.#bytes) return undefined;
      if (this.#confirmedHash === undefined) {
        this.#output.set(chunk, this.#bytes);
        owned = this.#output.subarray(this.#bytes, this.#bytes + chunk.byteLength);
      } else {
        if (chunk.buffer !== this.#output.buffer || chunk.byteOffset !== this.#bytes)
          return undefined;
        owned = chunk;
      }
    }
    if (this.#hasher !== undefined) this.#chunks.push(owned);
    this.#bytes += owned.byteLength;
    return owned;
  }

  public update(slice: Uint8Array): void {
    if (this.#output === undefined && this.#hasher === undefined) {
      this.#incremental.update(slice);
    }
  }

  public complete(): string | Promise<string> | undefined {
    if (this.#output !== undefined) {
      if (this.#bytes !== this.#output.byteLength) return undefined;
      return (
        this.#confirmedHash ??
        hashExactUtf8Output(this.#output, this.#signal, undefined, this.#checkpoint)
      );
    }
    if (this.#hasher === undefined) return this.#incremental.digestHex();
    return this.#hasher.hash(combineInputBytes(this.#chunks, this.#bytes));
  }

  public release(): void {
    this.#output = undefined;
    this.#confirmedHash = undefined;
    this.#chunks.length = 0;
  }
}
