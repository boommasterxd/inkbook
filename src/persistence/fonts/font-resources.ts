import { fontCssFamily } from "../../domain/text/font-family";
import { matchFontFace } from "../../domain/text/font-face-matching";
import type { FontResourceV2 } from "../../domain/schema/types";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { SampleBase64Reader, SampleBase64Writer } from "../serialization/metadata/sample-base64";
import { ChunkedSha256 } from "../serialization/chunked-output-sha256";
import { FONT_LIMITS } from "./font-container";
import { inspectFont } from "./font-validation";

export interface FontFaceRequest {
  readonly family: string;
  readonly weight: number;
  readonly style: "normal" | "italic";
}

export interface FontDescriptor extends FontFaceRequest {
  readonly license?: string;
  readonly weightRange?: readonly [number, number];
}

export { fontCssFamily } from "../../domain/text/font-family";

export async function createFontResource(
  bytes: Uint8Array,
  descriptor: FontDescriptor,
  scheduler: WorkScheduler,
  signal?: AbortSignal,
): Promise<FontResourceV2> {
  validateDescriptor(descriptor);
  signal?.throwIfAborted();
  const { mimeType } = inspectFont(bytes);
  const writer = new SampleBase64Writer();
  const hash = new ChunkedSha256();
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    const part = bytes.subarray(offset, offset + 4096);
    hash.update(part);
    for (const byte of part) writer.append(byte);
    const pending = scheduler.checkpoint(signal, "background");
    if (pending !== undefined) await pending;
    signal?.throwIfAborted();
  }
  return {
    family: descriptor.family,
    weight: descriptor.weight,
    style: descriptor.style,
    ...(descriptor.license === undefined ? {} : { license: descriptor.license }),
    ...(descriptor.weightRange === undefined
      ? {}
      : {
          weightRange: [descriptor.weightRange[0], descriptor.weightRange[1]] as [number, number],
        }),
    id: hash.digestHex(),
    mimeType,
    data: writer.finish(),
  };
}

export async function decodeFontResource(
  resource: Pick<FontResourceV2, "data">,
  scheduler: WorkScheduler,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  return runFontSteps(decodeFontResourceSteps(resource, signal), scheduler, signal);
}

export function* decodeFontResourceSteps(
  resource: Pick<FontResourceV2, "data">,
  signal?: AbortSignal,
): Generator<void, Uint8Array<ArrayBuffer>> {
  signal?.throwIfAborted();
  if (resource.data.length > Math.ceil(FONT_LIMITS.fileBytes / 3) * 4)
    throw new RangeError("Font exceeds limit.");
  const reader = new SampleBase64Reader(resource.data);
  const bytes = new Uint8Array(reader.byteLength);
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    const end = Math.min(offset + 4096, bytes.length);
    for (let index = offset; index < end; index += 1) bytes[index] = reader.read();
    yield;
    signal?.throwIfAborted();
  }
  return bytes;
}

export async function validateFontResource(
  resource: FontResourceV2,
  scheduler: WorkScheduler,
  signal?: AbortSignal,
): Promise<void> {
  return runFontSteps(validateFontResourceSteps(resource, signal), scheduler, signal);
}

export function* validateFontResourceSteps(
  resource: FontResourceV2,
  signal?: AbortSignal,
): Generator<void, void> {
  validateDescriptor(resource);
  const bytes = yield* decodeFontResourceSteps(resource, signal);
  const container = inspectFont(bytes);
  const hash = new ChunkedSha256();
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    hash.update(bytes.subarray(offset, offset + 4096));
    yield;
    signal?.throwIfAborted();
  }
  if (hash.digestHex() !== resource.id || container.mimeType !== resource.mimeType)
    throw new RangeError("Font identity does not match content.");
}

async function runFontSteps<T>(
  steps: Generator<void, T>,
  scheduler: WorkScheduler,
  signal?: AbortSignal,
): Promise<T> {
  let step = steps.next();
  while (!step.done) {
    const pending = scheduler.checkpoint(signal, "background");
    if (pending !== undefined) await pending;
    signal?.throwIfAborted();
    step = steps.next();
  }
  return step.value;
}

/** Preserve actual face descriptors; custom families permit native CSS fallback/synthesis. */
export function selectFontResources(
  resources: readonly FontResourceV2[],
  requests: readonly FontFaceRequest[],
  options?: { readonly allowFallback: boolean },
): FontResourceV2[] {
  const selected = new Map<string, FontResourceV2>();
  for (const request of requests) {
    const face = matchFontFace(resources, request, options?.allowFallback);
    if (face === undefined) throw new RangeError("Required font face is unavailable.");
    selected.set(`${face.family}:${face.weight}:${face.style}`, face);
  }
  const result = [...selected.values()];
  assertFontResourceSelection(result);
  return result;
}

export function assertFontResourceSelection(resources: readonly FontResourceV2[]): void {
  if (resources.length > FONT_LIMITS.documentFaces)
    throw new RangeError("Too many document font faces.");
  let bytes = 0;
  const hashes = new Set<string>();
  for (const face of resources) {
    if (hashes.has(face.id)) continue;
    hashes.add(face.id);
    bytes += (face.data.length / 4) * 3;
  }
  if (bytes > FONT_LIMITS.documentBytes) throw new RangeError("Document fonts exceed limit.");
}

function validateDescriptor(descriptor: FontDescriptor): void {
  fontCssFamily(descriptor.family);
  if (!Number.isInteger(descriptor.weight) || descriptor.weight < 1 || descriptor.weight > 1000)
    throw new RangeError("Invalid font weight.");
  if (descriptor.style !== "normal" && descriptor.style !== "italic")
    throw new RangeError("Invalid font style.");
  if (descriptor.license !== undefined && descriptor.license.length > 16384)
    throw new RangeError("Font license exceeds limit.");
  const range = descriptor.weightRange;
  if (range === undefined) return;
  if (
    range.length !== 2 ||
    !Number.isInteger(range[0]) ||
    !Number.isInteger(range[1]) ||
    range[0] < 1 ||
    range[1] > 1000 ||
    range[0] > descriptor.weight ||
    range[1] < descriptor.weight
  )
    throw new RangeError("Invalid variable font weight range.");
}
