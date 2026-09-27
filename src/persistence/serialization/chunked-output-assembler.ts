import { ChunkedSha256 } from "./chunked-output-sha256";

const DEFAULT_SLICE_BYTE_LIMIT = 64 * 1024;
const MAX_UTF8_BYTES_PER_CODE_UNIT = 3;

export interface ChunkedOutputAssembly {
  readonly hash: string;
  readonly output: string;
  readonly totalBytes: number;
}

export interface ChunkedUtf8OutputAssembly {
  readonly hash: string;
  readonly output: Uint8Array<ArrayBuffer>;
  readonly totalBytes: number;
}

export interface ChunkedOutputAssemblyOptions {
  readonly checkpoint?: () => Promise<void>;
  readonly maximumBytes?: number;
  readonly signal?: AbortSignal;
  readonly sliceByteLimit?: number;
}

export type ExactOutputDigest = (output: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>;

export class ChunkedOutputCancelledError extends Error {
  public constructor() {
    super("Chunked output assembly was cancelled.");
    this.name = "ChunkedOutputCancelledError";
  }
}

export class ChunkedOutputLimitError extends Error {
  public constructor() {
    super("Chunked output exceeds the configured byte limit.");
    this.name = "ChunkedOutputLimitError";
  }
}

export async function assembleAndHashChunkedOutput(
  fragments: Iterable<string>,
  options: ChunkedOutputAssemblyOptions = {},
): Promise<ChunkedOutputAssembly> {
  const sliceByteLimit = options.sliceByteLimit ?? DEFAULT_SLICE_BYTE_LIMIT;
  validateSliceByteLimit(sliceByteLimit);
  validateMaximumBytes(options.maximumBytes);
  throwIfCancelled(options.signal);

  const hash = new ChunkedSha256();
  const encoder = new FragmentUtf8Encoder(options.checkpoint === undefined ? null : sliceByteLimit);
  let output = "";
  let bytesSinceCheckpoint = 0;
  for (const fragment of fragments) {
    throwIfCancelled(options.signal);
    for (const encoded of encoder.encode(fragment)) {
      hash.update(encoded);
      throwIfMaximumExceeded(hash.totalBytes, options.maximumBytes);
      bytesSinceCheckpoint += encoded.byteLength;
      if (options.checkpoint !== undefined && bytesSinceCheckpoint >= sliceByteLimit) {
        await options.checkpoint();
        throwIfCancelled(options.signal);
        bytesSinceCheckpoint = 0;
      }
    }
    output += fragment;
  }
  const remainder = encoder.finish();
  hash.update(remainder);
  throwIfMaximumExceeded(hash.totalBytes, options.maximumBytes);
  bytesSinceCheckpoint += remainder.byteLength;
  if (options.checkpoint !== undefined && bytesSinceCheckpoint >= sliceByteLimit) {
    await options.checkpoint();
    throwIfCancelled(options.signal);
  }
  throwIfCancelled(options.signal);
  return { hash: hash.digestHex(), output, totalBytes: hash.totalBytes };
}

export async function assembleAndHashChunkedUtf8Output(
  fragments: Iterable<string>,
  totalBytes: number,
  options: ChunkedOutputAssemblyOptions = {},
): Promise<ChunkedUtf8OutputAssembly> {
  const sliceByteLimit = options.sliceByteLimit ?? DEFAULT_SLICE_BYTE_LIMIT;
  validateSliceByteLimit(sliceByteLimit);
  validateMaximumBytes(options.maximumBytes);
  throwIfMaximumExceeded(totalBytes, options.maximumBytes);
  throwIfCancelled(options.signal);
  const encoder = new FragmentUtf8Encoder(sliceByteLimit);
  const output = new ExactUtf8Output(totalBytes);
  let bytesSinceCheckpoint = 0;
  for (const fragment of fragments) {
    throwIfCancelled(options.signal);
    for (const written of encoder.encodeInto(fragment, output)) {
      bytesSinceCheckpoint += written;
      if (options.checkpoint !== undefined && bytesSinceCheckpoint >= sliceByteLimit) {
        await options.checkpoint();
        throwIfCancelled(options.signal);
        bytesSinceCheckpoint = 0;
      }
    }
  }
  encoder.finishInto(output);
  throwIfCancelled(options.signal);
  const exactOutput = output.finish();
  const hash = await hashExactUtf8Output(
    exactOutput,
    options.signal,
    undefined,
    options.checkpoint,
  );
  return { hash, output: exactOutput, totalBytes };
}

export async function hashExactUtf8Output(
  output: Uint8Array<ArrayBuffer>,
  signal?: AbortSignal,
  digest: ExactOutputDigest | null = platformDigest(),
  checkpoint?: () => Promise<void>,
): Promise<string> {
  throwIfCancelled(signal);
  if (digest !== null) {
    try {
      const result = await digest(output);
      throwIfCancelled(signal);
      if (result.byteLength === 32) return bytesToHex(new Uint8Array(result));
    } catch {
      throwIfCancelled(signal);
    }
  }
  const fallback = new ChunkedSha256();
  if (checkpoint === undefined) fallback.update(output);
  else {
    for (let offset = 0; offset < output.byteLength; offset += DEFAULT_SLICE_BYTE_LIMIT) {
      throwIfCancelled(signal);
      fallback.update(output.subarray(offset, offset + DEFAULT_SLICE_BYTE_LIMIT));
      await checkpoint();
    }
  }
  throwIfCancelled(signal);
  return fallback.digestHex();
}

class ExactUtf8Output {
  readonly #output: Uint8Array<ArrayBuffer>;
  #offset = 0;

  public constructor(totalBytes: number) {
    this.#output = new Uint8Array(totalBytes);
  }

  public appendText(input: string, encoder: TextEncoder): number {
    const target = this.#output.subarray(this.#offset);
    const { read, written } = encoder.encodeInto(input, target);
    if (read !== input.length) throw new ChunkedOutputLimitError();
    this.#offset += written;
    return written;
  }

  public finish(): Uint8Array<ArrayBuffer> {
    if (this.#offset !== this.#output.byteLength) {
      throw new RangeError("Chunked output byte count is inconsistent.");
    }
    return this.#output;
  }
}

class FragmentUtf8Encoder {
  readonly #encoder = new TextEncoder();
  readonly #maximumCodeUnits: number | null;
  #pendingHighSurrogate = "";

  public constructor(sliceByteLimit: number | null) {
    this.#maximumCodeUnits =
      sliceByteLimit === null
        ? null
        : Math.max(1, Math.floor(sliceByteLimit / MAX_UTF8_BYTES_PER_CODE_UNIT));
  }

  public *encode(fragment: string): Iterable<Uint8Array> {
    const input = this.#nextInput(fragment);
    for (let offset = 0; offset < input.length;) {
      const end = this.#safeEnd(input, offset);
      yield this.#encoder.encode(input.slice(offset, end));
      offset = end;
    }
  }

  public *encodeInto(fragment: string, output: ExactUtf8Output): Iterable<number> {
    let input = this.#nextInput(fragment);
    for (let offset = 0; offset < input.length;) {
      const end = this.#safeEnd(input, offset);
      yield output.appendText(input.slice(offset, end), this.#encoder);
      offset = end;
    }
  }

  public finish(): Uint8Array {
    if (this.#pendingHighSurrogate.length === 0) return new Uint8Array();
    const encoded = this.#encoder.encode(this.#pendingHighSurrogate);
    this.#pendingHighSurrogate = "";
    return encoded;
  }

  public finishInto(output: ExactUtf8Output): void {
    if (this.#pendingHighSurrogate.length === 0) return;
    output.appendText(this.#pendingHighSurrogate, this.#encoder);
    this.#pendingHighSurrogate = "";
  }

  #nextInput(fragment: string): string {
    let input = this.#pendingHighSurrogate + fragment;
    this.#pendingHighSurrogate = "";
    if (hasTrailingHighSurrogate(input)) {
      this.#pendingHighSurrogate = input[input.length - 1]!;
      input = input.slice(0, -1);
    }
    return input;
  }

  #safeEnd(input: string, offset: number): number {
    if (this.#maximumCodeUnits === null) return input.length;
    let end = Math.min(input.length, offset + this.#maximumCodeUnits);
    if (end < input.length && hasTrailingHighSurrogate(input.slice(offset, end))) end -= 1;
    if (end === offset) return Math.min(input.length, offset + 2);
    return end;
  }
}

function hasTrailingHighSurrogate(value: string): boolean {
  if (value.length === 0) return false;
  const code = value.charCodeAt(value.length - 1);
  return code >= 0xd800 && code <= 0xdbff;
}

function validateSliceByteLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("Chunked output slice byte limit must be a positive safe integer.");
  }
}

function validateMaximumBytes(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError("Chunked output maximum byte limit must be a non-negative safe integer.");
  }
}

function throwIfMaximumExceeded(totalBytes: number, maximumBytes: number | undefined): void {
  if (maximumBytes !== undefined && totalBytes > maximumBytes) {
    throw new ChunkedOutputLimitError();
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new ChunkedOutputCancelledError();
}

function platformDigest(): ExactOutputDigest | null {
  if (typeof crypto === "undefined" || crypto.subtle === undefined) return null;
  const subtle = crypto.subtle;
  return (output) => subtle.digest("SHA-256", output);
}

function bytesToHex(bytes: Uint8Array): string {
  let output = "";
  for (const value of bytes) output += value.toString(16).padStart(2, "0");
  return output;
}
