import { FILE_SCHEMA_LIMITS } from "../../domain/schema/constants";
import { validateSafeSvgSteps, type SafeSvgValidation } from "../documents/safe-svg-validator";
import type { SafeSvgVersionPolicy } from "../documents/svg-envelope-root";
import { ChunkedSha256 } from "../serialization/chunked-output-sha256";
import { hashExactUtf8Output } from "../serialization/chunked-output-assembler";
import { SafeStaticProof } from "../serialization/safe-static-proof";

import { adoptUtf8Output, type Utf8AdoptionOptions } from "./utf8-adoption";
import { createMainThreadCheckpoint } from "./main-thread-checkpoint";

const HASH = /^[0-9a-f]{64}$/u;
const DEFAULT_CHUNK_BYTES = 64 * 1024;
const MAX_NATIVE_HASH_BYTES = 20 * 1024 * 1024;

export interface TrustedSvgOutput {
  readonly content: string;
  readonly lockedHeight: number;
  readonly outputHash: string;
  readonly revision: number;
  readonly snapshotHash: string | null;
  readonly totalBytes: number;
  readonly safeStaticProof: SafeStaticProof;
}

interface TrustedSvgInspectionOptions extends Utf8AdoptionOptions {
  readonly versionPolicy?: SafeSvgVersionPolicy;
  readonly waitForBackground?: () => Promise<void> | undefined;
}

/** Hashes complete bounded bytes without repeating validation of an owned exact output. */
export async function hashSvgContent(
  content: string,
  options: TrustedSvgInspectionOptions = {},
): Promise<string> {
  const { checkpoint, pending, chunkBytes } = prepareHash(options);
  if (pending !== undefined) await pending;
  options.signal?.throwIfAborted();
  const inspected = await inspectString(content, chunkBytes, checkpoint, options.signal);
  options.signal?.throwIfAborted();
  return inspected.outputHash;
}

/** Uses a bounded native digest for confirmed-base preflight; other inputs retain sliced hashing. */
export async function hashConfirmedSvgContent(
  content: string,
  options: TrustedSvgInspectionOptions = {},
): Promise<string> {
  if (
    content.length > MAX_NATIVE_HASH_BYTES ||
    typeof crypto === "undefined" ||
    crypto.subtle === undefined
  )
    return hashSvgContent(content, options);
  const { checkpoint, pending, chunkBytes } = prepareHash(options);
  if (pending !== undefined) await pending;
  options.signal?.throwIfAborted();
  const encoded = await encodeConfirmedContent(
    content,
    Math.min(chunkBytes, DEFAULT_CHUNK_BYTES),
    checkpoint,
    options.signal,
  );
  if (encoded === null) return hashSvgContent(content, options);
  return hashExactUtf8Output(encoded, options.signal, undefined, checkpoint);
}

function prepareHash(options: TrustedSvgInspectionOptions) {
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  assertChunkBytes(chunkBytes);
  const checkpoint =
    options.checkpoint ??
    createMainThreadCheckpoint(options.workScheduler, options.waitForBackground);
  return { checkpoint, chunkBytes, pending: checkpoint() };
}

async function encodeConfirmedContent(
  content: string,
  chunkBytes: number,
  checkpoint: () => Promise<void> | undefined,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const encoder = new TextEncoder();
  let output = new Uint8Array(Math.max(1, content.length));
  let writtenBytes = 0;
  for (let offset = 0; offset < content.length;) {
    signal?.throwIfAborted();
    const end = nextChunkEnd(content, offset, chunkBytes);
    let fragment = content.slice(offset, end);
    while (fragment.length > 0) {
      const encoded = encoder.encodeInto(fragment, output.subarray(writtenBytes));
      writtenBytes += encoded.written;
      fragment = fragment.slice(encoded.read);
      if (fragment.length > 0) {
        const capacity = Math.min(MAX_NATIVE_HASH_BYTES, output.byteLength * 2);
        if (capacity <= output.byteLength) return null;
        const grown = new Uint8Array(capacity);
        grown.set(output.subarray(0, writtenBytes));
        output = grown;
      }
    }
    offset = end;
    const pending = checkpoint();
    if (pending !== undefined) await pending;
  }
  signal?.throwIfAborted();
  return output.subarray(0, writtenBytes);
}

export async function inspectTrustedSvgOutput(
  output: string | Uint8Array,
  expectedHash?: string,
  options: TrustedSvgInspectionOptions = {},
): Promise<TrustedSvgOutput> {
  options.signal?.throwIfAborted();
  const waitForBackground = options.waitForBackground;
  const yieldCheckpoint = options.checkpoint ?? createMainThreadCheckpoint(options.workScheduler);
  const checkpoint = (): Promise<void> | undefined => {
    options.signal?.throwIfAborted();
    const ready = waitForBackground?.();
    const pending = ready === undefined ? yieldCheckpoint() : ready.then(yieldCheckpoint);
    if (pending !== undefined) return pending.then(() => options.signal?.throwIfAborted());
    options.signal?.throwIfAborted();
    return undefined;
  };
  const pending = checkpoint();
  if (pending !== undefined) await pending;
  options.signal?.throwIfAborted();
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  assertChunkBytes(chunkBytes);
  const inspected = await inspectOutput(output, chunkBytes, checkpoint, options.signal);
  assertExpectedHash(inspected.outputHash, expectedHash);
  const safe = await validateSafeSvgIncrementally(
    inspected.content,
    inspected.totalBytes,
    checkpoint,
    options.signal,
    options.versionPolicy,
    options.workScheduler,
  );
  if (safe === null) throw new TypeError("Worker output is not a safe Inkbook SVG document.");
  return trustedOutput(inspected, safe);
}

interface InspectedOutput {
  readonly content: string;
  readonly outputHash: string;
  readonly totalBytes: number;
}

async function inspectOutput(
  output: string | Uint8Array,
  chunkBytes: number,
  checkpoint: () => Promise<void> | undefined,
  signal?: AbortSignal,
): Promise<InspectedOutput> {
  if (typeof output === "string") return inspectString(output, chunkBytes, checkpoint, signal);
  return inspectBytes(output, chunkBytes, checkpoint, signal);
}

async function inspectBytes(
  output: Uint8Array,
  chunkBytes: number,
  checkpoint: () => Promise<void> | undefined,
  signal?: AbortSignal,
): Promise<InspectedOutput> {
  assertOwnedBytes(output);
  const hasher = new ChunkedSha256();
  for (let offset = 0; offset < output.byteLength; offset += chunkBytes) {
    signal?.throwIfAborted();
    hasher.update(output.subarray(offset, Math.min(output.byteLength, offset + chunkBytes)));
    const pending = checkpoint();
    if (pending !== undefined) await pending;
    signal?.throwIfAborted();
  }
  const content = await adoptUtf8Output(output, {
    checkpoint,
    chunkBytes,
    ...(signal ? { signal } : {}),
  });
  return { content, outputHash: hasher.digestHex(), totalBytes: output.byteLength };
}

async function inspectString(
  output: string,
  chunkBytes: number,
  checkpoint: () => Promise<void> | undefined,
  signal?: AbortSignal,
): Promise<InspectedOutput> {
  const hasher = new ChunkedSha256();
  const encoder = new TextEncoder();
  for (let offset = 0; offset < output.length;) {
    signal?.throwIfAborted();
    const end = nextChunkEnd(output, offset, chunkBytes);
    hasher.update(encoder.encode(output.slice(offset, end)));
    if (hasher.totalBytes > FILE_SCHEMA_LIMITS.totalInputBytes) throw oversizedOutput();
    offset = end;
    const pending = checkpoint();
    if (pending !== undefined) await pending;
    signal?.throwIfAborted();
  }
  return { content: output, outputHash: hasher.digestHex(), totalBytes: hasher.totalBytes };
}

function nextChunkEnd(input: string, offset: number, chunkCodeUnits: number): number {
  let end = Math.min(input.length, offset + chunkCodeUnits);
  const trailing = input.charCodeAt(end - 1);
  if (
    end < input.length &&
    trailing >= 0xd800 &&
    trailing <= 0xdbff &&
    input.charCodeAt(end) >= 0xdc00 &&
    input.charCodeAt(end) <= 0xdfff
  )
    end += end - offset === 1 ? 1 : -1;
  return end;
}

async function validateSafeSvgIncrementally(
  content: string,
  totalBytes: number,
  checkpoint: () => Promise<void> | undefined,
  signal?: AbortSignal,
  versionPolicy: SafeSvgVersionPolicy = "current",
  workScheduler?: Utf8AdoptionOptions["workScheduler"],
): Promise<SafeSvgValidation | null> {
  signal?.throwIfAborted();
  const steps = validateSafeSvgSteps(content, {
    deadlineExceeded: () => workScheduler?.shouldYield() ?? false,
    totalInputBytes: totalBytes,
    versionPolicy,
  });
  let step = steps.next();
  while (!step.done) {
    signal?.throwIfAborted();
    const pending = checkpoint();
    if (pending !== undefined) await pending;
    signal?.throwIfAborted();
    step = steps.next();
  }
  signal?.throwIfAborted();
  return step.value;
}

function trustedOutput(inspected: InspectedOutput, safe: SafeSvgValidation): TrustedSvgOutput {
  return {
    ...inspected,
    safeStaticProof: SafeStaticProof.fromTrustedProducer(
      inspected.outputHash,
      inspected.totalBytes,
    ),
    lockedHeight: safe.lockedHeight,
    revision: safe.revision,
    snapshotHash: safe.snapshotHash,
  };
}

function assertOwnedBytes(output: Uint8Array): void {
  if (
    !(output.buffer instanceof ArrayBuffer) ||
    output.byteOffset !== 0 ||
    output.byteLength !== output.buffer.byteLength
  ) {
    throw new TypeError("Worker output must exclusively own a full-span ArrayBuffer.");
  }
  if (output.byteLength > FILE_SCHEMA_LIMITS.totalInputBytes) throw oversizedOutput();
}

function assertExpectedHash(actual: string, expected?: string): void {
  if (expected !== undefined && (!HASH.test(expected) || actual !== expected)) {
    throw new TypeError("Worker output hash does not match its exact SVG bytes.");
  }
}

function assertChunkBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("Trusted SVG inspection chunk size must be a positive safe integer.");
  }
}

function oversizedOutput(): RangeError {
  return new RangeError("Worker output exceeds the 64 MiB document limit.");
}
