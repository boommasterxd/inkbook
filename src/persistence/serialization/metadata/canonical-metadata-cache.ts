import {
  FILE_SCHEMA_LIMITS,
  type InkElementV1,
  type InkSnapshotV1,
} from "../../../domain/schema/public";
import {
  canonicalElementFragments,
  canonicalStrokeMetadataFrame,
} from "./canonical-element-fragments";
import { encodeStrokeSampleBytesSteps } from "./stroke-sample-codec";
import { metadataPrefix } from "./canonical-metadata";
import { ChunkedSha256 } from "../chunked-output-sha256";

const encoder = new TextEncoder();
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_ELEMENTS = 20_000;
const CHUNK_BYTES = 64 * 1024;
const CHECKPOINT_FRAGMENTS = 64;
const COMMA_BYTES = encoder.encode(",");
const SUFFIX_BYTES = encoder.encode("]}");

interface CachedElement {
  readonly byteLength: number;
  readonly element: WeakRef<InkElementV1>;
  readonly fragments: readonly Uint8Array<ArrayBuffer>[];
  readonly samples?: {
    readonly points: WeakRef<Extract<InkElementV1, { kind: "stroke" }>["points"]>;
    readonly bytes: Uint8Array<ArrayBuffer>;
  };
}

function retainedBytes(entry: Pick<CachedElement, "fragments">): number {
  return entry.fragments.reduce((sum, fragment) => sum + fragment.byteLength, 0);
}

/** Session-owned canonical bytes; only immutable Store identities may be reused. */
export class CanonicalMetadataCache {
  readonly #elements = new Map<string, CachedElement>();

  public constructor(readonly ownsElement: (element: InkElementV1) => boolean = () => false) {}
  #bytes = 0;
  #released = false;

  public clear(): void {
    this.#released = true;
    this.#elements.clear();
    this.#bytes = 0;
  }

  public async digest(
    snapshot: InkSnapshotV1,
    checkpoint: () => Promise<void> | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    const fragments = [encoder.encode(metadataPrefix(snapshot.revision, snapshot.page))];
    let length = fragments[0]!.byteLength + 2;
    let pendingBytes = 0;
    let pendingElements = 0;
    for (const element of snapshot.elements) {
      signal?.throwIfAborted();
      const resolved = this.#elementBytes(element, checkpoint, signal);
      const elementFragments = resolved instanceof Promise ? await resolved : resolved;
      if (fragments.length > 1) {
        fragments.push(COMMA_BYTES);
        length += 1;
      }
      fragments.push(...elementFragments);
      const elementBytes = elementFragments.reduce((sum, fragment) => sum + fragment.byteLength, 0);
      length += elementBytes;
      if (length > FILE_SCHEMA_LIMITS.metadataBytes) throw new RangeError("Metadata byte limit.");
      pendingBytes += elementBytes;
      pendingElements += 1;
      if (pendingBytes >= CHUNK_BYTES || pendingElements >= CHECKPOINT_FRAGMENTS) {
        const pending = checkpoint();
        if (pending !== undefined) await pending;
        pendingBytes = 0;
        pendingElements = 0;
      }
    }
    if (pendingElements > 0) {
      const pending = checkpoint();
      if (pending !== undefined) await pending;
    }
    fragments.push(SUFFIX_BYTES);
    const output = await copyMetadataBytes(fragments, length, checkpoint, signal);
    return digestBytes(output, checkpoint, signal);
  }

  #elementBytes(
    element: InkElementV1,
    checkpoint: () => Promise<void> | undefined,
    signal?: AbortSignal,
  ): readonly Uint8Array<ArrayBuffer>[] | Promise<readonly Uint8Array<ArrayBuffer>[]> {
    const cached = this.#elements.get(element.id);
    if (cached !== undefined) {
      this.#elements.delete(element.id);
      this.#bytes -= cached.byteLength;
      if (cached.element.deref() === element && this.ownsElement(element)) {
        this.#elements.set(element.id, cached);
        this.#bytes += cached.byteLength;
        return cached.fragments;
      }
    }
    return consumeMetadataSteps(this.#encodeElement(element, cached, signal), checkpoint, signal);
  }

  *#encodeElement(
    element: InkElementV1,
    cached: CachedElement | undefined,
    signal?: AbortSignal,
  ): Generator<void, readonly Uint8Array<ArrayBuffer>[]> {
    const owned = this.ownsElement(element);
    const samples =
      owned && element.kind === "stroke" && cached?.samples?.points.deref() === element.points
        ? cached.samples.bytes
        : undefined;
    const encoded =
      element.kind === "stroke"
        ? yield* this.#strokeBytes(element, samples, signal)
        : {
            fragments: [yield* encodeFragments(canonicalElementFragments(element), signal)],
          };
    signal?.throwIfAborted();
    if (!this.#released && this.ownsElement(element) && retainedBytes(encoded) <= MAX_CACHE_BYTES)
      this.#retain(element, encoded.fragments, encoded.samples);
    return encoded.fragments;
  }

  *#strokeBytes(
    element: Extract<InkElementV1, { kind: "stroke" }>,
    reusedSamples: Uint8Array<ArrayBuffer> | undefined,
    signal?: AbortSignal,
  ): Generator<void, Pick<CachedElement, "fragments" | "samples">> {
    const { prefix, suffix } = canonicalStrokeMetadataFrame(element);
    const samples = reusedSamples ?? (yield* encodeStrokeSampleBytesSteps(element.points, signal));
    signal?.throwIfAborted();
    const fragments = [encoder.encode(prefix), samples, encoder.encode(suffix)];
    if (
      fragments.reduce((sum, fragment) => sum + fragment.byteLength, 0) >
      FILE_SCHEMA_LIMITS.metadataBytes
    )
      throw new RangeError("Metadata byte limit.");
    return { fragments, samples: { points: new WeakRef(element.points), bytes: samples } };
  }

  #retain(
    element: InkElementV1,
    fragments: readonly Uint8Array<ArrayBuffer>[],
    samples?: CachedElement["samples"],
  ): void {
    const entry: CachedElement = {
      byteLength: fragments.reduce((sum, fragment) => sum + fragment.byteLength, 0),
      element: new WeakRef(element),
      fragments,
      ...(samples && { samples }),
    };
    const size = entry.byteLength;
    const previous = this.#elements.get(element.id);
    if (previous !== undefined) {
      this.#bytes -= previous.byteLength;
      this.#elements.delete(element.id);
    }
    while (this.#bytes + size > MAX_CACHE_BYTES || this.#elements.size >= MAX_CACHE_ELEMENTS) {
      const oldest = this.#elements.keys().next().value!;
      this.#bytes -= this.#elements.get(oldest)!.byteLength;
      this.#elements.delete(oldest);
    }
    this.#elements.set(element.id, entry);
    this.#bytes += size;
  }
}

async function copyMetadataBytes(
  fragments: readonly Uint8Array<ArrayBuffer>[],
  length: number,
  checkpoint: () => Promise<void> | undefined,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const output = new Uint8Array(length);
  let offset = 0;
  let pendingBytes = 0;
  let pendingFragments = 0;
  for (const fragment of fragments) {
    for (let start = 0; start < fragment.byteLength;) {
      signal?.throwIfAborted();
      const end = Math.min(fragment.byteLength, start + CHUNK_BYTES - pendingBytes);
      const chunk = fragment.subarray(start, end);
      output.set(chunk, offset);
      offset += chunk.byteLength;
      start = end;
      pendingBytes += chunk.byteLength;
      pendingFragments += 1;
      if (pendingBytes === CHUNK_BYTES || pendingFragments >= CHECKPOINT_FRAGMENTS) {
        const pending = checkpoint();
        if (pending !== undefined) await pending;
        pendingBytes = 0;
        pendingFragments = 0;
      }
    }
  }
  if (pendingFragments > 0) {
    const pending = checkpoint();
    if (pending !== undefined) await pending;
  }
  return output;
}

function* encodeFragments(
  fragments: Iterable<string>,
  signal?: AbortSignal,
): Generator<void, Uint8Array<ArrayBuffer>> {
  const encoded: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  for (const fragment of fragments) {
    signal?.throwIfAborted();
    const bytes = encoder.encode(fragment);
    encoded.push(bytes);
    length += bytes.byteLength;
    if (length > FILE_SCHEMA_LIMITS.metadataBytes) throw new RangeError("Metadata byte limit.");
    yield;
  }
  return joinBytes(encoded, length);
}

function joinBytes(
  fragments: readonly Uint8Array<ArrayBuffer>[],
  length = fragments.reduce((sum, fragment) => sum + fragment.byteLength, 0),
): Uint8Array<ArrayBuffer> {
  if (fragments.length === 1) return fragments[0]!;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const fragment of fragments) {
    bytes.set(fragment, offset);
    offset += fragment.byteLength;
  }
  return bytes;
}

async function digestBytes(
  bytes: Uint8Array<ArrayBuffer>,
  checkpoint: () => Promise<void> | undefined,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (typeof crypto !== "undefined" && crypto.subtle !== undefined) {
    try {
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      signal?.throwIfAborted();
      if (digest.byteLength === 32)
        return Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
    } catch {
      signal?.throwIfAborted();
    }
  }
  const hasher = new ChunkedSha256();
  for (let start = 0; start < bytes.byteLength; start += CHUNK_BYTES) {
    signal?.throwIfAborted();
    hasher.update(bytes.subarray(start, start + CHUNK_BYTES));
    const pending = checkpoint();
    if (pending !== undefined) await pending;
  }
  return hasher.digestHex();
}

/** Keep preparation synchronous until the injected scheduler actually requests a handoff. */
function consumeMetadataSteps<T>(
  steps: Generator<void, T>,
  checkpoint: () => Promise<void> | undefined,
  signal?: AbortSignal,
): T | Promise<T> {
  try {
    for (;;) {
      signal?.throwIfAborted();
      const step = steps.next();
      if (step.done) return step.value;
      const pending = checkpoint();
      if (pending !== undefined) return resumeMetadataSteps(steps, pending, checkpoint, signal);
    }
  } catch (error) {
    steps.return(undefined as T);
    throw error;
  }
}

async function resumeMetadataSteps<T>(
  steps: Generator<void, T>,
  pending: Promise<void>,
  checkpoint: () => Promise<void> | undefined,
  signal?: AbortSignal,
): Promise<T> {
  try {
    await pending;
    signal?.throwIfAborted();
    let step = steps.next();
    while (!step.done) {
      const next = checkpoint();
      if (next !== undefined) await next;
      signal?.throwIfAborted();
      step = steps.next();
    }
    return step.value;
  } catch (error) {
    steps.return(undefined as T);
    throw error;
  }
}
