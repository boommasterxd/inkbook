import { encodeCanonicalJson } from "../../domain/codecs";
import type {
  BindingRevision,
  ElementId,
  GeometryRevision,
  SceneElementV1,
  StyleRevision,
} from "../../domain/model";

const MEBIBYTE = 1_048_576;
export const PERSISTENCE_ELEMENT_CHUNK_CACHE_MAX_PAYLOAD_BYTES_V1 =
  Number("16") * MEBIBYTE;
const PERSISTENCE_ELEMENT_CHUNK_CACHE_DEFAULT_PAYLOAD_BYTES_V1 =
  PERSISTENCE_ELEMENT_CHUNK_CACHE_MAX_PAYLOAD_BYTES_V1;
const PERSISTENCE_ELEMENT_CHUNK_CACHE_MAX_COUNT_V1 = 100_000;

export interface PersistenceEncodedElementChunkV1 {
  readonly elementId: ElementId;
  readonly geometryRevision: GeometryRevision;
  readonly styleRevision: StyleRevision;
  readonly bindingRevision: BindingRevision;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

interface PreparedElementChunksV1 {
  readonly chunks: readonly PersistenceEncodedElementChunkV1[];
  readonly encodedElementCount: number;
  readonly reusedElementCount: number;
}

interface CompletedNoteCacheV1 {
  readonly chunks: Map<ElementId, PersistenceEncodedElementChunkV1>;
  readonly byteLength: number;
}

type PersistenceElementChunkCommitStatusV1 = "retained" | "released-over-limit";

export interface PersistenceElementChunkCacheUseV1 {
  release(): void;
}

export class PersistenceElementChunkCacheV1 {
  readonly #maximumBytes: number;
  readonly #maximumCount: number;
  #notes = new Map<string, CompletedNoteCacheV1>();
  #disposableLru = new Map<string, true>();
  #activeUses = new Map<string, number>();
  #ownedPayloadBytes = 0;
  #ownedCount = 0;
  #disposed = false;

  constructor(
    maximumBytes = PERSISTENCE_ELEMENT_CHUNK_CACHE_DEFAULT_PAYLOAD_BYTES_V1,
    maximumCount = PERSISTENCE_ELEMENT_CHUNK_CACHE_MAX_COUNT_V1,
  ) {
    assertCapacity(
      maximumBytes,
      PERSISTENCE_ELEMENT_CHUNK_CACHE_MAX_PAYLOAD_BYTES_V1,
      "Element chunk cache bytes",
    );
    assertCapacity(
      maximumCount,
      PERSISTENCE_ELEMENT_CHUNK_CACHE_MAX_COUNT_V1,
      "Element chunk cache count",
    );
    this.#maximumBytes = maximumBytes;
    this.#maximumCount = maximumCount;
  }

  get ownedPayloadBytes(): number {
    return this.#ownedPayloadBytes;
  }

  get ownedCount(): number {
    return this.#ownedCount;
  }

  get noteCount(): number {
    return this.#notes.size;
  }

  beginUse(noteKey: string): PersistenceElementChunkCacheUseV1 {
    this.assertUsable();
    assertNoteKey(noteKey);
    const active = this.#activeUses.get(noteKey) ?? 0;
    this.#activeUses.set(noteKey, active + 1);
    this.#disposableLru.delete(noteKey);
    let released = false;
    return Object.freeze({
      release: (): void => {
        if (released) return;
        released = true;
        this.releaseUse(noteKey);
      },
    });
  }

  prepare(
    noteKey: string,
    elements: readonly SceneElementV1[],
    affectedElementIds: readonly ElementId[],
  ): PreparedElementChunksV1 {
    this.assertUsable();
    const affected = new Set(affectedElementIds);
    const chunks: PersistenceEncodedElementChunkV1[] = [];
    let encodedElementCount = 0;
    for (const element of elements) {
      const cached = this.findReusable(
        noteKey,
        element,
        affected.has(element.elementId),
      );
      const chunk = cached ?? encodeElementChunk(element);
      if (chunk !== cached) encodedElementCount += 1;
      chunks.push(chunk);
    }
    return Object.freeze({
      chunks: Object.freeze(chunks),
      encodedElementCount,
      reusedElementCount: chunks.length - encodedElementCount,
    });
  }

  findReusable(
    noteKey: string,
    element: SceneElementV1,
    affected: boolean,
  ): PersistenceEncodedElementChunkV1 | undefined {
    this.assertUsable();
    const note = this.#notes.get(noteKey);
    if (note === undefined) return undefined;
    this.touch(noteKey, note);
    if (affected) return undefined;
    const cached = note.chunks.get(element.elementId);
    return cached !== undefined && revisionsMatch(cached, element)
      ? cached
      : undefined;
  }

  commit(
    noteKey: string,
    chunks: readonly PersistenceEncodedElementChunkV1[],
  ): PersistenceElementChunkCommitStatusV1 {
    this.assertUsable();
    const owned = new Map<ElementId, PersistenceEncodedElementChunkV1>();
    let ownedBytes = 0;
    for (const chunk of chunks) {
      const replaced = owned.get(chunk.elementId);
      if (replaced !== undefined) ownedBytes -= replaced.bytes.byteLength;
      owned.set(chunk.elementId, chunk);
      ownedBytes += chunk.bytes.byteLength;
    }
    return this.commitOwned(noteKey, owned, ownedBytes);
  }

  /** Takes exclusive map ownership; the caller must not mutate it afterward. */
  commitOwned(
    noteKey: string,
    chunks: Map<ElementId, PersistenceEncodedElementChunkV1>,
    ownedBytes: number,
  ): PersistenceElementChunkCommitStatusV1 {
    this.assertUsable();
    assertNoteKey(noteKey);
    assertOwnedSize(ownedBytes);
    assertOwnedSize(chunks.size);
    this.remove(noteKey);
    if (ownedBytes > this.#maximumBytes || chunks.size > this.#maximumCount) {
      return "released-over-limit";
    }
    if (!this.evictFor(ownedBytes, chunks.size)) {
      return "released-over-limit";
    }
    this.#notes.set(noteKey, { chunks, byteLength: ownedBytes });
    if (!this.isActive(noteKey)) this.#disposableLru.set(noteKey, true);
    this.#ownedPayloadBytes += ownedBytes;
    this.#ownedCount += chunks.size;
    return "retained";
  }

  clear(noteKey?: string): void {
    if (noteKey !== undefined) {
      this.remove(noteKey);
      return;
    }
    this.#notes = new Map();
    this.#disposableLru = new Map();
    this.#ownedPayloadBytes = 0;
    this.#ownedCount = 0;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.clear();
    this.#activeUses = new Map();
    this.#disposed = true;
  }

  private evictFor(incomingBytes: number, incomingCount: number): boolean {
    while (
      incomingBytes > this.#maximumBytes - this.#ownedPayloadBytes ||
      incomingCount > this.#maximumCount - this.#ownedCount
    ) {
      const leastRecent = this.#disposableLru.keys().next();
      if (leastRecent.done === true) return false;
      this.remove(leastRecent.value);
    }
    return true;
  }

  private touch(noteKey: string, note: CompletedNoteCacheV1): void {
    this.#notes.delete(noteKey);
    this.#notes.set(noteKey, note);
    if (this.isActive(noteKey)) return;
    this.#disposableLru.delete(noteKey);
    this.#disposableLru.set(noteKey, true);
  }

  private releaseUse(noteKey: string): void {
    const active = this.#activeUses.get(noteKey);
    if (active === undefined) return;
    if (active > 1) {
      this.#activeUses.set(noteKey, active - 1);
      return;
    }
    this.#activeUses.delete(noteKey);
    if (this.#notes.has(noteKey)) this.#disposableLru.set(noteKey, true);
  }

  private isActive(noteKey: string): boolean {
    return (this.#activeUses.get(noteKey) ?? 0) > 0;
  }

  private remove(noteKey: string): void {
    const removed = this.#notes.get(noteKey);
    if (removed === undefined) return;
    this.#notes.delete(noteKey);
    this.#disposableLru.delete(noteKey);
    this.#ownedPayloadBytes -= removed.byteLength;
    this.#ownedCount -= removed.chunks.size;
  }

  private assertUsable(): void {
    if (this.#disposed) throw new Error("Element chunk cache is disposed.");
  }
}

export function createPersistenceEncodedElementChunkV1(
  element: SceneElementV1,
  bytes: Uint8Array<ArrayBuffer>,
): PersistenceEncodedElementChunkV1 {
  return Object.freeze({
    elementId: element.elementId,
    geometryRevision: element.geometryRevision,
    styleRevision: element.styleRevision,
    bindingRevision: element.bindingRevision,
    bytes,
  });
}

function encodeElementChunk(
  element: SceneElementV1,
): PersistenceEncodedElementChunkV1 {
  return createPersistenceEncodedElementChunkV1(
    element,
    encodeCanonicalJson(element) as Uint8Array<ArrayBuffer>,
  );
}

function revisionsMatch(
  chunk: PersistenceEncodedElementChunkV1,
  element: SceneElementV1,
): boolean {
  return (
    chunk.geometryRevision === element.geometryRevision &&
    chunk.styleRevision === element.styleRevision &&
    chunk.bindingRevision === element.bindingRevision
  );
}

function assertCapacity(value: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} is outside its bounded range.`);
  }
}

function assertOwnedSize(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Element chunk ownership is outside its range.");
  }
}

function assertNoteKey(noteKey: string): void {
  if (noteKey.length === 0) throw new TypeError("Note cache key is empty.");
}
