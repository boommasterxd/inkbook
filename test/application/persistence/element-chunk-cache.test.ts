/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact cache capacities are the tested boundaries. */
import { describe, expect, it } from "vitest";

import {
  createPersistenceEncodedElementChunkV1,
  PERSISTENCE_ELEMENT_CHUNK_CACHE_MAX_PAYLOAD_BYTES_V1,
  PersistenceElementChunkCacheV1,
  type PersistenceEncodedElementChunkV1,
} from "../../../src/application/persistence";
import type { SceneElementV1 } from "../../../src/domain/model";
import { completeSidecar } from "./support";

const NOTE_A = "Notes/A.md";
const NOTE_B = "Notes/B.md";
const NOTE_C = "Notes/C.md";

function elementAt(index: number): SceneElementV1 {
  const element = completeSidecar().scene.elements[index];
  if (element === undefined) throw new Error("Missing element fixture.");
  return element;
}

function chunkAt(
  index: number,
  byteLength: number,
): PersistenceEncodedElementChunkV1 {
  return createPersistenceEncodedElementChunkV1(
    elementAt(index),
    new Uint8Array(byteLength),
  );
}

describe("persistence element chunk cache pool", () => {
  it("retains alternating note caches without displacing warm chunks", () => {
    const cache = new PersistenceElementChunkCacheV1(8, 4);
    const chunkA = chunkAt(0, 2);
    const chunkB = chunkAt(1, 2);
    cache.commit(NOTE_A, [chunkA]);
    cache.commit(NOTE_B, [chunkB]);

    expect(cache.findReusable(NOTE_A, elementAt(0), false)).toBe(chunkA);
    expect(cache.findReusable(NOTE_B, elementAt(1), false)).toBe(chunkB);
    expect(cache.noteCount).toBe(2);
    expect(cache.ownedPayloadBytes).toBe(4);
    expect(cache.ownedCount).toBe(2);
  });

  it("enforces configured payload bytes below, at, and above the limit", () => {
    const cache = new PersistenceElementChunkCacheV1(4, 4);

    expect(cache.commit(NOTE_A, [chunkAt(0, 3)])).toBe("retained");
    expect(cache.ownedPayloadBytes).toBe(3);
    expect(cache.commit(NOTE_A, [chunkAt(0, 4)])).toBe("retained");
    expect(cache.ownedPayloadBytes).toBe(4);
    expect(cache.commit(NOTE_A, [chunkAt(0, 5)])).toBe("released-over-limit");
    expect(cache.ownedPayloadBytes).toBe(0);
    expect(cache.noteCount).toBe(0);
  });

  it("enforces configured retained counts below, at, and above the limit", () => {
    const cache = new PersistenceElementChunkCacheV1(8, 2);

    expect(cache.commit(NOTE_A, [chunkAt(0, 1)])).toBe("retained");
    expect(cache.ownedCount).toBe(1);
    expect(cache.commit(NOTE_A, [chunkAt(0, 1), chunkAt(1, 1)])).toBe(
      "retained",
    );
    expect(cache.ownedCount).toBe(2);
    expect(
      cache.commit(NOTE_A, [chunkAt(0, 1), chunkAt(1, 1), chunkAt(2, 1)]),
    ).toBe("released-over-limit");
    expect(cache.ownedCount).toBe(0);
  });

  it("evicts the deterministic disposable LRU note only", () => {
    const cache = new PersistenceElementChunkCacheV1(2, 2);
    cache.commit(NOTE_A, [chunkAt(0, 1)]);
    cache.commit(NOTE_B, [chunkAt(1, 1)]);
    const useA = cache.beginUse(NOTE_A);

    expect(cache.commit(NOTE_C, [chunkAt(2, 1)])).toBe("retained");
    expect(cache.findReusable(NOTE_A, elementAt(0), false)).toBeDefined();
    expect(cache.findReusable(NOTE_B, elementAt(1), false)).toBeUndefined();
    expect(cache.findReusable(NOTE_C, elementAt(2), false)).toBeDefined();
    useA.release();
  });

  it("releases replaced payload ownership before retaining the new map", () => {
    const cache = new PersistenceElementChunkCacheV1(8, 4);
    cache.commit(NOTE_A, [chunkAt(0, 6)]);
    const replacement = chunkAt(0, 2);
    const owned = new Map([[replacement.elementId, replacement]]);

    expect(cache.commitOwned(NOTE_A, owned, 2)).toBe("retained");
    expect(cache.ownedPayloadBytes).toBe(2);
    expect(cache.ownedCount).toBe(1);
    expect(cache.findReusable(NOTE_A, elementAt(0), false)).toBe(replacement);
  });

  it("clears one note or all notes and disposes idempotently", () => {
    const cache = new PersistenceElementChunkCacheV1(8, 4);
    cache.commit(NOTE_A, [chunkAt(0, 2)]);
    cache.commit(NOTE_B, [chunkAt(1, 2)]);
    const activeUse = cache.beginUse(NOTE_B);

    cache.clear(NOTE_A);
    expect(cache.noteCount).toBe(1);
    expect(cache.ownedPayloadBytes).toBe(2);
    cache.clear();
    expect(cache.noteCount).toBe(0);
    expect(cache.ownedPayloadBytes).toBe(0);
    expect(cache.ownedCount).toBe(0);

    cache.dispose();
    cache.dispose();
    activeUse.release();
    activeUse.release();
    expect(cache.noteCount).toBe(0);
    expect(cache.ownedPayloadBytes).toBe(0);
    expect(() => cache.commit(NOTE_A, [chunkAt(0, 1)])).toThrow("disposed");
  });

  it("rejects configuration above the persistence-local absolute ceiling", () => {
    expect(
      () =>
        new PersistenceElementChunkCacheV1(
          PERSISTENCE_ELEMENT_CHUNK_CACHE_MAX_PAYLOAD_BYTES_V1 + 1,
        ),
    ).toThrow(RangeError);
  });
});
