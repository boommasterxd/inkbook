import { ChunkedSha256 } from "./chunked-output-sha256";

const DEFAULT_SLICE_BYTE_LIMIT = 64 * 1024;

export interface ChunkedUtf8OutputAssembly {
  readonly hash: string;
  readonly output: Uint8Array<ArrayBuffer>;
  readonly totalBytes: number;
}

export interface ChunkedOutputAssemblyOptions {
  readonly checkpoint?: () => Promise<void> | undefined;
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

export async function assembleAndHashPreparedUtf8Output(
  fragments: Iterable<Uint8Array>,
  totalBytes: number,
  options: ChunkedOutputAssemblyOptions = {},
): Promise<ChunkedUtf8OutputAssembly> {
  const sliceByteLimit = options.sliceByteLimit ?? DEFAULT_SLICE_BYTE_LIMIT;
  validateSliceByteLimit(sliceByteLimit);
  validateMaximumBytes(options.maximumBytes);
  throwIfMaximumExceeded(totalBytes, options.maximumBytes);
  throwIfCancelled(options.signal);
  const output = new ExactUtf8Output(totalBytes);
  let bytesSinceCheckpoint = 0;
  for (const fragment of fragments) {
    throwIfCancelled(options.signal);
    for (let offset = 0; offset < fragment.byteLength;) {
      const end = Math.min(fragment.byteLength, offset + sliceByteLimit);
      bytesSinceCheckpoint += output.appendBytes(fragment.subarray(offset, end));
      offset = end;
      if (options.checkpoint !== undefined && bytesSinceCheckpoint >= sliceByteLimit) {
        const pending = options.checkpoint();
        if (pending !== undefined) await pending;
        throwIfCancelled(options.signal);
        bytesSinceCheckpoint = 0;
      }
    }
  }
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
  checkpoint?: () => Promise<void> | undefined,
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
      const pending = checkpoint();
      if (pending !== undefined) await pending;
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

  public appendBytes(input: Uint8Array): number {
    if (input.byteLength > this.#output.byteLength - this.#offset) {
      throw new ChunkedOutputLimitError();
    }
    this.#output.set(input, this.#offset);
    this.#offset += input.byteLength;
    return input.byteLength;
  }

  public finish(): Uint8Array<ArrayBuffer> {
    if (this.#offset !== this.#output.byteLength) {
      throw new RangeError("Chunked output byte count is inconsistent.");
    }
    return this.#output;
  }
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
