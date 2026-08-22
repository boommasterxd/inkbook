import { yieldToMainThread } from "./main-thread-yield";

const DEFAULT_CHUNK_BYTES = 256 * 1024;
const MAIN_THREAD_SLICE_MS = 4;

export interface Utf8AdoptionOptions {
  readonly checkpoint?: () => Promise<void>;
  readonly chunkBytes?: number;
  readonly signal?: AbortSignal;
}

export async function adoptUtf8Output(
  output: string | Uint8Array,
  options: Utf8AdoptionOptions = {},
): Promise<string> {
  if (typeof output === "string") return output;
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) {
    throw new RangeError("UTF-8 adoption chunk size must be a positive safe integer.");
  }
  const checkpoint = options.checkpoint ?? createMainThreadCheckpoint();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const segments: Array<string | undefined> = [];
  for (let offset = 0; offset < output.byteLength; offset += chunkBytes) {
    options.signal?.throwIfAborted();
    const end = Math.min(output.byteLength, offset + chunkBytes);
    appendSegment(
      segments,
      decoder.decode(output.subarray(offset, end), { stream: end < output.byteLength }),
    );
    await checkpoint();
  }
  options.signal?.throwIfAborted();
  appendSegment(segments, decoder.decode());
  await checkpoint();
  options.signal?.throwIfAborted();
  return concatenateSegments(segments);
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

function createMainThreadCheckpoint(): () => Promise<void> {
  let sliceStarted = performance.now();
  return async () => {
    if (performance.now() - sliceStarted < MAIN_THREAD_SLICE_MS) return;
    await yieldToMainThread();
    sliceStarted = performance.now();
  };
}
