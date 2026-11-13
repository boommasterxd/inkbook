import initialize, { DecompressStream, type InitOutput } from "brotli-dec-wasm/web";
import source from "brotli-dec-wasm/web/bg.wasm?url&inline";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { decodeFontResource } from "./font-resources";
import { FONT_LIMITS, invalidFont } from "./font-container";
import { boundBrotliWasmMemory } from "./bounded-wasm-memory";

const CHUNK_BYTES = 4096;
const MAX_DECODER_MEMORY = 64 * 1024 * 1024;
let initialization: Promise<InitOutput> | undefined;

async function decoder(scheduler: WorkScheduler): Promise<InitOutput> {
  initialization ??= (async () => {
    const data = source.startsWith("data:") ? source.slice(source.indexOf(",") + 1) : source;
    const bytes = await decodeFontResource({ data }, scheduler);
    return initialize({ module_or_path: boundBrotliWasmMemory(bytes) });
  })();
  return initialization;
}

/** RFC 7932 reserves this prefix; its extension can request a 1-GiB history window. */
function assertStandardWindow(input: Uint8Array): void {
  if (input.length === 0 || (input[0]! & 0x7f) === 0x11) invalidFont();
}

/** Fixed output buffers permit shared admission without retaining the full font stream. */
export async function decodeBrotliFont(
  input: Uint8Array,
  expectedBytes: number,
  options: {
    readonly scheduler: WorkScheduler;
    readonly receive: (bytes: Uint8Array, offset: number) => void;
    readonly signal?: AbortSignal;
  },
): Promise<void> {
  if (
    input.length > FONT_LIMITS.fileBytes ||
    expectedBytes <= 0 ||
    expectedBytes > FONT_LIMITS.decodedBytes
  )
    invalidFont();
  options.signal?.throwIfAborted();
  assertStandardWindow(input);
  const module = await decoder(options.scheduler);
  options.signal?.throwIfAborted();
  const stream = new DecompressStream();
  let consumed = 0;
  let produced = 0;
  try {
    for (;;) {
      const part = input.subarray(consumed, consumed + CHUNK_BYTES);
      const step = readStep(stream, part, expectedBytes - produced, module);
      const { code, read, bytes } = step;
      options.receive(bytes, produced);
      consumed += read;
      produced += bytes.length;
      if (code === 1) {
        if (
          consumed !== input.length ||
          produced !== expectedBytes ||
          stream.total_out() !== produced
        )
          invalidFont();
        return;
      }
      assertProgress(step, part.length, consumed, input.length);
      const pending = options.scheduler.checkpoint(options.signal, "background");
      if (pending !== undefined) await pending;
      options.signal?.throwIfAborted();
    }
  } finally {
    stream.free();
  }
}

interface DecoderStep {
  readonly code: number;
  readonly read: number;
  readonly bytes: Uint8Array;
}

function readStep(
  stream: DecompressStream,
  part: Uint8Array,
  remaining: number,
  module: InitOutput,
): DecoderStep {
  const result = stream.decompress(part, CHUNK_BYTES);
  try {
    const step = { code: result.code, read: result.input_offset, bytes: result.buf };
    if (
      step.read > part.length ||
      step.bytes.length > remaining ||
      module.memory.buffer.byteLength > MAX_DECODER_MEMORY
    )
      invalidFont();
    return step;
  } finally {
    result.free();
  }
}

function assertProgress(
  step: DecoderStep,
  supplied: number,
  consumed: number,
  inputBytes: number,
): void {
  if (step.read === 0 && step.bytes.length === 0) invalidFont();
  if (step.code === 2 && (step.read !== supplied || consumed === inputBytes)) invalidFont();
  if (step.code === 3 && step.bytes.length !== CHUNK_BYTES) invalidFont();
  if (step.code !== 2 && step.code !== 3) invalidFont();
}
