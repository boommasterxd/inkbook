import { ChunkedSha256 } from "../chunked-output-sha256";
import { hashExactUtf8Output, MAX_NATIVE_HASH_BYTES } from "../output/chunked-output-assembler";
import type { ChunkedInkbookInputOptions } from "./chunked-input-types";
import { combineInputBytes } from "./chunked-input-utils";
import { SafeStaticProof } from "./safe-static-proof";
import type { DocumentHashPort } from "../sha256";
import type { ChunkedInputCheckpoint } from "./chunked-input-types";

/** Owns the bytes decoded by one parser; export may retain one bounded terminal-digest buffer. */
export class ChunkedInputHash {
  readonly #hasher: DocumentHashPort | undefined;
  readonly #signal: AbortSignal | undefined;
  readonly #checkpoint: ChunkedInputCheckpoint | undefined;
  readonly #incremental = new ChunkedSha256();
  readonly #chunks: Uint8Array[] = [];
  #output: Uint8Array<ArrayBuffer> | undefined;
  #bytes = 0;
  #writing = false;

  public constructor(options: ChunkedInkbookInputOptions) {
    this.#hasher = options.hasher;
    this.#signal = options.signal;
    this.#checkpoint = options.checkpoint;
    const proof = options.safeStaticProof;
    const totalBytes = SafeStaticProof.isAuthentic(proof) ? proof.totalBytes : undefined;
    if (
      options.nativeExportHash === true &&
      options.staticValidation === "safe" &&
      this.#hasher === undefined &&
      options.onValidatedSnapshot === undefined &&
      options.sampleEncodingCache === undefined &&
      totalBytes !== undefined &&
      totalBytes <= MAX_NATIVE_HASH_BYTES &&
      typeof crypto !== "undefined" &&
      crypto.subtle !== undefined
    ) {
      this.#output = new Uint8Array(totalBytes);
    }
  }

  public get hasCustomHasher(): boolean {
    return this.#hasher !== undefined;
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
      this.#output.set(chunk, this.#bytes);
      owned = this.#output.subarray(this.#bytes, this.#bytes + chunk.byteLength);
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
      return hashExactUtf8Output(this.#output, this.#signal, undefined, this.#checkpoint);
    }
    if (this.#hasher === undefined) return this.#incremental.digestHex();
    return this.#hasher.hash(combineInputBytes(this.#chunks, this.#bytes));
  }

  public release(): void {
    this.#output = undefined;
    this.#chunks.length = 0;
  }
}
