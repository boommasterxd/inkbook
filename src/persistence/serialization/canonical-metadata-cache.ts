import {
  FILE_SCHEMA_LIMITS,
  type InkElementV1,
  type InkSnapshotV1,
} from "../../domain/schema/public";
import { canonicalElementFragments } from "./canonical-element-fragments";
import { metadataPrefix } from "./canonical-metadata";
import { ChunkedSha256 } from "./chunked-output-sha256";

const encoder = new TextEncoder();
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_ELEMENTS = 20_000;
const CHUNK_BYTES = 64 * 1024;

/** Session-owned canonical bytes; only immutable Store identities may be reused. */
export class CanonicalMetadataCache {
  readonly #elements = new Map<
    string,
    { readonly element: WeakRef<InkElementV1>; readonly bytes: Uint8Array<ArrayBuffer> }
  >();

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
    checkpoint: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<string> {
    const fragments = [encoder.encode(metadataPrefix(snapshot.revision, snapshot.page))];
    let length = fragments[0]!.byteLength + 2;
    for (const element of snapshot.elements) {
      signal?.throwIfAborted();
      const fragment = await this.#elementBytes(element, checkpoint, signal);
      if (fragments.length > 1) {
        fragments.push(encoder.encode(","));
        length += 1;
      }
      fragments.push(fragment);
      length += fragment.byteLength;
      if (length > FILE_SCHEMA_LIMITS.metadataBytes) throw new RangeError("Metadata byte limit.");
      await checkpoint();
    }
    fragments.push(encoder.encode("]}"));
    const output = new Uint8Array(length);
    let offset = 0;
    for (const fragment of fragments) {
      for (let start = 0; start < fragment.byteLength; start += CHUNK_BYTES) {
        signal?.throwIfAborted();
        const chunk = fragment.subarray(start, start + CHUNK_BYTES);
        output.set(chunk, offset);
        offset += chunk.byteLength;
        await checkpoint();
      }
    }
    return digestBytes(output, checkpoint, signal);
  }

  async #elementBytes(
    element: InkElementV1,
    checkpoint: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const cached = this.#elements.get(element.id);
    if (cached !== undefined) {
      this.#elements.delete(element.id);
      this.#bytes -= cached.bytes.byteLength;
      if (cached.element.deref() === element && this.ownsElement(element)) {
        this.#elements.set(element.id, cached);
        this.#bytes += cached.bytes.byteLength;
        return cached.bytes;
      }
    }
    const fragments: Uint8Array<ArrayBuffer>[] = [];
    let length = 0;
    for (const fragment of canonicalElementFragments(element)) {
      signal?.throwIfAborted();
      const bytes = encoder.encode(fragment);
      fragments.push(bytes);
      length += bytes.byteLength;
      if (length > FILE_SCHEMA_LIMITS.metadataBytes) throw new RangeError("Metadata byte limit.");
      await checkpoint();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const fragment of fragments) {
      bytes.set(fragment, offset);
      offset += fragment.byteLength;
    }
    if (!this.#released && this.ownsElement(element) && length <= MAX_CACHE_BYTES)
      this.#retain(element, bytes);
    return bytes;
  }

  #retain(element: InkElementV1, bytes: Uint8Array<ArrayBuffer>): void {
    const previous = this.#elements.get(element.id);
    if (previous !== undefined) {
      this.#bytes -= previous.bytes.byteLength;
      this.#elements.delete(element.id);
    }
    while (
      this.#bytes + bytes.byteLength > MAX_CACHE_BYTES ||
      this.#elements.size >= MAX_CACHE_ELEMENTS
    ) {
      const oldest = this.#elements.keys().next().value!;
      this.#bytes -= this.#elements.get(oldest)!.bytes.byteLength;
      this.#elements.delete(oldest);
    }
    this.#elements.set(element.id, { element: new WeakRef(element), bytes });
    this.#bytes += bytes.byteLength;
  }
}

async function digestBytes(
  bytes: Uint8Array<ArrayBuffer>,
  checkpoint: () => Promise<void>,
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
    await checkpoint();
  }
  return hasher.digestHex();
}
