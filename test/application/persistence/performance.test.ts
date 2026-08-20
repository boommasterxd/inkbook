/* eslint-disable @typescript-eslint/no-magic-numbers -- Normative performance tiers and exact resource boundaries are the tested contract. */
import { describe, expect, it } from "vitest";

import {
  PERSISTENCE_DECODED_MEMORY_MAX_BYTES_V1,
  PersistenceDecodedBytePoolV1,
  createPersistenceEncodeWorkV1,
  createPersistenceParseWorkV1,
} from "../../../src/application/persistence/codec-work";
import { PersistenceElementChunkCacheV1 } from "../../../src/application/persistence/element-chunk-cache";
import {
  encodeInkbookSidecarV1,
  SIDECAR_RESOURCE_LIMITS_V1,
  type InkbookSidecarV1,
} from "../../../src/application/persistence";
import { PersistencePermitPool } from "../../../src/application/persistence/save-pipeline";
import { canonicalizeJson } from "../../../src/domain/codecs";
import {
  createGeometryRevision,
  createNotePointV1,
  createSceneRevision,
} from "../../../src/domain/model";
import { rectangleElement } from "../../domain/model/support";
import { completeSidecar, executePersistenceCodecProcessor } from "./support";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined)
    throw new Error("Deferred was not initialized.");
  return { promise, resolve: resolvePromise };
}

function tenThousandElementSidecar(): InkbookSidecarV1 {
  const sidecar = completeSidecar();
  const elements = Array.from({ length: 10_000 }, (_, index) =>
    rectangleElement(index),
  );
  return {
    ...sidecar,
    scene: {
      ...sidecar.scene,
      elements,
      objectOrder: elements.map(({ elementId }) => elementId),
      revision: createSceneRevision(10_000),
    },
  };
}

function changeFirstElement(sidecar: InkbookSidecarV1): InkbookSidecarV1 {
  const first = sidecar.scene.elements[0];
  if (first?.kind !== "rectangle")
    throw new Error("Expected rectangle fixture.");
  const replacement = {
    ...first,
    geometryRevision: createGeometryRevision(first.geometryRevision + 1),
    geometry: {
      ...first.geometry,
      center: createNotePointV1(
        first.geometry.center.x + 1,
        first.geometry.center.y,
      ),
    },
  };
  return {
    ...sidecar,
    scene: {
      ...sidecar.scene,
      elements: [replacement, ...sidecar.scene.elements.slice(1)],
      revision: createSceneRevision(sidecar.scene.revision + 1),
    },
  };
}

describe("persistence performance contracts", () => {
  it("PERF-10K-PARSE functionally parses an admitted cold 16 MiB sidecar without claiming host latency", () => {
    const payload = canonicalizeJson(completeSidecar());
    const padding = " ".repeat(
      SIDECAR_RESOURCE_LIMITS_V1.maxUtf8Bytes - payload.length,
    );
    const rawText = `${padding}${payload}`;
    const admittedDecodedBytes = rawText.length * 2;
    const decodedBytes = new PersistenceDecodedBytePoolV1().tryAcquire(
      admittedDecodedBytes,
    );
    if (decodedBytes === null)
      throw new Error("Expected decoded-memory admission.");

    const work = createPersistenceParseWorkV1(
      rawText,
      SIDECAR_RESOURCE_LIMITS_V1.maxUtf8Bytes,
      decodedBytes,
    );
    const result = executePersistenceCodecProcessor(work);

    expect(rawText).toHaveLength(SIDECAR_RESOURCE_LIMITS_V1.maxUtf8Bytes);
    expect(work.admittedDecodedBytes).toBe(admittedDecodedBytes);
    expect(work.textChunks.every(({ length }) => length <= 16_384)).toBe(true);
    expect(result.kind).toBe("parsed-sidecar");
    if (result.kind === "parsed-sidecar")
      expect(result.value.kind).toBe("current");
    decodedBytes.release();
  }, 30_000);

  it("PERF-10K-PARSE rejects invalid decoded-memory preflight values before codec execution", () => {
    const pool = new PersistenceDecodedBytePoolV1(4);
    const owner = pool.tryAcquire(4);
    if (owner === null) throw new Error("Expected decoded-memory admission.");
    expect(pool.tryAcquire(1)).toBeNull();
    owner.release();
    expect(() => createPersistenceParseWorkV1("{}", 2, owner)).toThrow(Error);
    expect(() =>
      pool.tryAcquire(PERSISTENCE_DECODED_MEMORY_MAX_BYTES_V1 + 1),
    ).toThrow(RangeError);
    const replacementOwner = pool.tryAcquire(4);
    if (replacementOwner === null) {
      throw new Error("Expected replacement decoded-memory admission.");
    }
    expect(() =>
      createPersistenceParseWorkV1(
        "{}",
        SIDECAR_RESOURCE_LIMITS_V1.maxUtf8Bytes + 1,
        replacementOwner,
      ),
    ).toThrow(RangeError);
  });
});

describe("persistence bounded save work", () => {
  it("bounds multi-note work while blocked I/O holds both desktop permits", async () => {
    const pool = new PersistencePermitPool("desktop-tablet");
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const thirdAbort = new AbortController();
    const first = await pool.acquire(firstAbort.signal);
    const second = await pool.acquire(secondAbort.signal);
    const third = deferred<true>();
    const waiting = pool.acquire(thirdAbort.signal).then((permit) => {
      expect(permit).not.toBeNull();
      permit?.release();
      third.resolve(true);
    });

    expect(pool.activeCount).toBe(2);
    expect(pool.waitingCount).toBe(1);
    first?.release();
    await third.promise;
    second?.release();
    await waiting;
    expect(pool.activeCount).toBe(0);
    expect(pool.waitingCount).toBe(0);
  });

  it("PERF-10K-SAVE-WARM re-encodes one affected element and reuses 9,999 canonical chunks", () => {
    const coldSidecar = tenThousandElementSidecar();
    const warmSidecar = changeFirstElement(coldSidecar);
    const affected = warmSidecar.scene.elements[0]?.elementId;
    if (affected === undefined) throw new Error("Expected affected element.");
    const owner = new PersistenceDecodedBytePoolV1().tryAcquire(
      64 * 1024 * 1024,
    );
    if (owner === null) throw new Error("Expected decoded-memory admission.");
    const cache = new PersistenceElementChunkCacheV1();
    const cold = executePersistenceCodecProcessor(
      createPersistenceEncodeWorkV1(
        coldSidecar,
        "desktop-tablet",
        owner,
        SIDECAR_RESOURCE_LIMITS_V1.maxUtf8Bytes,
      ),
      cache,
    );
    const warm = executePersistenceCodecProcessor(
      createPersistenceEncodeWorkV1(
        warmSidecar,
        "desktop-tablet",
        owner,
        SIDECAR_RESOURCE_LIMITS_V1.maxUtf8Bytes,
        [affected],
      ),
      cache,
    );
    if (cold.kind !== "encoded-sidecar" || warm.kind !== "encoded-sidecar") {
      throw new Error("Expected encoded sidecars.");
    }

    expect(cold.encodedElementCount).toBe(10_000);
    expect(warm.encodedElementCount).toBe(1);
    expect(warm.reusedElementCount).toBe(9_999);
    expect(warm.bytes).toEqual(
      encodeInkbookSidecarV1(warmSidecar, "desktop-tablet"),
    );
    owner.release();
  }, 30_000);

  it("PERF-10K-TEARDOWN removes a detached waiter and releases every permit", async () => {
    const pool = new PersistencePermitPool("phone");
    const active = await pool.acquire(new AbortController().signal);
    const detached = new AbortController();
    const waiting = pool.acquire(detached.signal);
    expect(pool.waitingCount).toBe(1);

    detached.abort();
    await expect(waiting).resolves.toBeNull();
    active?.release();
    expect(pool.activeCount).toBe(0);
    expect(pool.waitingCount).toBe(0);
  });
});
