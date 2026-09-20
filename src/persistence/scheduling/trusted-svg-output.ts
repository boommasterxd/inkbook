import { FILE_SCHEMA_LIMITS } from "../../domain/schema/constants";
import {
  validateSafeSvg,
  validateSafeSvgSteps,
  type SafeSvgValidation,
} from "../documents/safe-svg-validator";
import type { SafeSvgVersionPolicy } from "../documents/svg-envelope-root";
import { ChunkedSha256 } from "../serialization/chunked-output-sha256";

import { adoptUtf8Output, type Utf8AdoptionOptions } from "./utf8-adoption";
import { createMainThreadCheckpoint, createMainThreadDeadline } from "./main-thread-checkpoint";

const HASH = /^[0-9a-f]{64}$/u;
const DEFAULT_CHUNK_BYTES = 64 * 1024;

export interface TrustedSvgOutput {
  readonly content: string;
  readonly lockedHeight: number;
  readonly outputHash: string;
  readonly revision: number;
  readonly snapshotHash: string | null;
  readonly totalBytes: number;
}

interface TrustedSvgInspectionOptions extends Utf8AdoptionOptions {
  readonly versionPolicy?: SafeSvgVersionPolicy;
  readonly waitForBackground?: () => Promise<void>;
}

export function inspectTrustedSvgOutputSync(
  output: string | Uint8Array,
  expectedHash?: string,
): TrustedSvgOutput {
  const inspected = inspectBytesSync(output);
  assertExpectedHash(inspected.outputHash, expectedHash);
  const safe = validateSafeSvg(inspected.content);
  if (safe === null) throw new TypeError("Worker output is not a safe Inkbook SVG document.");
  return trustedOutput(inspected, safe);
}

export async function inspectTrustedSvgOutput(
  output: string | Uint8Array,
  expectedHash?: string,
  options: TrustedSvgInspectionOptions = {},
): Promise<TrustedSvgOutput> {
  options.signal?.throwIfAborted();
  const yieldCheckpoint = options.checkpoint ?? createMainThreadCheckpoint(options.sliceBudgetMs);
  const waitForBackground = options.waitForBackground;
  const checkpoint = waitForBackground
    ? async () => {
        await yieldCheckpoint();
        await waitForBackground();
        options.signal?.throwIfAborted();
      }
    : yieldCheckpoint;
  if (waitForBackground) await waitForBackground();
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
    options.sliceBudgetMs,
  );
  if (safe === null) throw new TypeError("Worker output is not a safe Inkbook SVG document.");
  return trustedOutput(inspected, safe);
}

interface InspectedOutput {
  readonly content: string;
  readonly outputHash: string;
  readonly totalBytes: number;
}

function inspectBytesSync(output: string | Uint8Array): InspectedOutput {
  if (typeof output === "string") {
    const hasher = new ChunkedSha256();
    updateStringHash(output, DEFAULT_CHUNK_BYTES, hasher);
    return { content: output, outputHash: hasher.digestHex(), totalBytes: hasher.totalBytes };
  }
  assertOwnedBytes(output);
  const hasher = new ChunkedSha256();
  hasher.update(output);
  const content = new TextDecoder("utf-8", { fatal: true }).decode(output);
  return { content, outputHash: hasher.digestHex(), totalBytes: output.byteLength };
}

async function inspectOutput(
  output: string | Uint8Array,
  chunkBytes: number,
  checkpoint: () => Promise<void>,
  signal?: AbortSignal,
): Promise<InspectedOutput> {
  if (typeof output === "string") return inspectString(output, chunkBytes, checkpoint, signal);
  return inspectBytes(output, chunkBytes, checkpoint, signal);
}

async function inspectBytes(
  output: Uint8Array,
  chunkBytes: number,
  checkpoint: () => Promise<void>,
  signal?: AbortSignal,
): Promise<InspectedOutput> {
  assertOwnedBytes(output);
  const hasher = new ChunkedSha256();
  for (let offset = 0; offset < output.byteLength; offset += chunkBytes) {
    signal?.throwIfAborted();
    hasher.update(output.subarray(offset, Math.min(output.byteLength, offset + chunkBytes)));
    await checkpoint();
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
  checkpoint: () => Promise<void>,
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
    await checkpoint();
    signal?.throwIfAborted();
  }
  return { content: output, outputHash: hasher.digestHex(), totalBytes: hasher.totalBytes };
}

function updateStringHash(output: string, chunkBytes: number, hasher: ChunkedSha256): void {
  const encoder = new TextEncoder();
  for (let offset = 0; offset < output.length;) {
    const end = nextChunkEnd(output, offset, chunkBytes);
    hasher.update(encoder.encode(output.slice(offset, end)));
    if (hasher.totalBytes > FILE_SCHEMA_LIMITS.totalInputBytes) throw oversizedOutput();
    offset = end;
  }
}

function nextChunkEnd(input: string, offset: number, chunkCodeUnits: number): number {
  let end = Math.min(input.length, offset + chunkCodeUnits);
  const trailing = input.charCodeAt(end - 1);
  if (end < input.length && trailing >= 0xd800 && trailing <= 0xdbff) end -= 1;
  return end;
}

async function validateSafeSvgIncrementally(
  content: string,
  totalBytes: number,
  checkpoint: () => Promise<void>,
  signal?: AbortSignal,
  versionPolicy: SafeSvgVersionPolicy = "current",
  sliceBudgetMs?: () => number,
): Promise<SafeSvgValidation | null> {
  const deadline = createMainThreadDeadline(sliceBudgetMs);
  signal?.throwIfAborted();
  const steps = validateSafeSvgSteps(content, {
    deadlineExceeded: deadline.exceeded,
    totalInputBytes: totalBytes,
    versionPolicy,
  });
  let step = steps.next();
  while (!step.done) {
    signal?.throwIfAborted();
    await checkpoint();
    signal?.throwIfAborted();
    deadline.restart();
    step = steps.next();
  }
  signal?.throwIfAborted();
  return step.value;
}

function trustedOutput(inspected: InspectedOutput, safe: SafeSvgValidation): TrustedSvgOutput {
  return {
    ...inspected,
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
