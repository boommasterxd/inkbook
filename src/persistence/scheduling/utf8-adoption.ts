import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { createMainThreadCheckpoint } from "./main-thread-checkpoint";

const DEFAULT_CHUNK_BYTES = 256 * 1024;
export const UTF8_OUTPUT_PREFIX_CODE_UNITS = 4 * 1024;

export interface Utf8AdoptionOptions {
  readonly checkpoint?: () => Promise<void> | undefined;
  readonly chunkBytes?: number;
  readonly signal?: AbortSignal;
  readonly workScheduler?: WorkScheduler;
}

export function adoptUtf8Output(
  output: string | Uint8Array,
  options: Utf8AdoptionOptions = {},
): Promise<string> {
  return decodeUtf8Output(output, options);
}

export async function adoptUtf8OutputWithPrefix(
  output: string | Uint8Array,
  options: Utf8AdoptionOptions = {},
): Promise<{ readonly content: string; readonly prefix: string }> {
  if (typeof output === "string") {
    return { content: output, prefix: output.slice(0, UTF8_OUTPUT_PREFIX_CODE_UNITS) };
  }
  const prefix = new DecodedPrefix();
  const content = await decodeUtf8Output(output, options, prefix);
  return { content, prefix: prefix.finish() };
}

async function decodeUtf8Output(
  output: string | Uint8Array,
  options: Utf8AdoptionOptions,
  prefix?: DecodedPrefix,
): Promise<string> {
  if (typeof output === "string") return output;
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) {
    throw new RangeError("UTF-8 adoption chunk size must be a positive safe integer.");
  }
  const checkpoint = options.checkpoint ?? createMainThreadCheckpoint(options.workScheduler);
  const initialCheckpoint = checkpoint();
  if (initialCheckpoint !== undefined) await initialCheckpoint;
  options.signal?.throwIfAborted();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const segments: Array<string | undefined> = [];
  for (let offset = 0; offset < output.byteLength; offset += chunkBytes) {
    options.signal?.throwIfAborted();
    const end = Math.min(output.byteLength, offset + chunkBytes);
    const decoded = decoder.decode(output.subarray(offset, end), {
      stream: end < output.byteLength,
    });
    prefix?.append(decoded);
    appendSegment(segments, decoded);
    const pending = checkpoint();
    if (pending !== undefined) await pending;
  }
  options.signal?.throwIfAborted();
  const decoded = decoder.decode();
  prefix?.append(decoded);
  appendSegment(segments, decoded);
  const finalCheckpoint = checkpoint();
  if (finalCheckpoint !== undefined) await finalCheckpoint;
  options.signal?.throwIfAborted();
  return concatenateSegments(segments);
}

class DecodedPrefix {
  readonly #codeUnits = new Uint16Array(UTF8_OUTPUT_PREFIX_CODE_UNITS);
  #length = 0;

  public append(decoded: string): void {
    const length = Math.min(decoded.length, this.#codeUnits.length - this.#length);
    for (let index = 0; index < length; index += 1) {
      this.#codeUnits[this.#length++] = decoded.charCodeAt(index);
    }
  }

  public finish(): string {
    return String.fromCharCode(...this.#codeUnits.subarray(0, this.#length));
  }
}

function appendSegment(segments: Array<string | undefined>, decoded: string): void {
  if (decoded.length === 0) return;
  let segment = decoded;
  let level = 0;
  while (segments[level] !== undefined) {
    segment = segments[level] + segment;
    segments[level] = undefined;
    level += 1;
  }
  segments[level] = segment;
}

function concatenateSegments(segments: ReadonlyArray<string | undefined>): string {
  let adopted = "";
  for (let level = segments.length - 1; level >= 0; level -= 1) {
    adopted += segments[level] ?? "";
  }
  return adopted;
}
