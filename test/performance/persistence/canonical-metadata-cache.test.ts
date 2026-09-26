import type { InkElementV1 } from "../../../src/domain/schema/public";
import { rectangle } from "../../unit/persistence/worker/runtime/fixtures";
import { expect, it, vi } from "vitest";
import { CanonicalMetadataCache } from "../../../src/persistence/serialization/canonical-metadata-cache";
import * as canonical from "../../../src/persistence/serialization/canonical-snapshot";
import { createTestStroke, createWorkerSnapshot } from "../../fixtures/persistence/worker-snapshot";

it("serializes only replaced elements across a 10,000-stroke save and releases cached ownership", async () => {
  let pointReads = 0;
  const elements = Array.from({ length: 10_000 }, (_, index) => {
    const stroke = createTestStroke();
    const samples = new Proxy(stroke.points, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/u.test(property)) pointReads += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    return Object.freeze({ ...stroke, id: String(index), points: samples });
  });
  const snapshot = createWorkerSnapshot(elements);
  const cache = new CanonicalMetadataCache(Object.isFrozen);
  const checkpoint = async () => undefined;
  const canonicalize = vi.spyOn(canonical, "canonicalElement");
  try {
    const before = await cache.digest(snapshot, checkpoint);
    expect(pointReads).toBe(60_000);
    expect(canonicalize).toHaveBeenCalledTimes(10_000);
    canonicalize.mockClear();
    pointReads = 0;
    expect(await cache.digest(snapshot, checkpoint)).toBe(before);
    expect(pointReads).toBe(0);
    expect(canonicalize).not.toHaveBeenCalled();
    snapshot.revision += 1;
    snapshot.elements[500] = Object.freeze({ ...elements[500]!, rotation: 90 });
    expect(await cache.digest(snapshot, checkpoint)).not.toBe(before);
    expect(pointReads).toBe(6);
    expect(canonicalize).toHaveBeenCalledOnce();
    cache.clear();
    canonicalize.mockClear();
    pointReads = 0;
    await cache.digest(snapshot, checkpoint);
    expect(pointReads).toBe(60_000);
    expect(canonicalize).toHaveBeenCalledTimes(10_000);
  } finally {
    canonicalize.mockRestore();
  }
});

it("evicts the least recently used element after 20,000 retained identities", async () => {
  const elements = Array.from({ length: 20_000 }, (_, index) =>
    Object.freeze({
      ...rectangle(),
      id: elementId(index),
    }),
  );
  const extra = Object.freeze({ ...rectangle(), id: elementId(20_000) });
  const cache = new CanonicalMetadataCache(Object.isFrozen);
  const digest = (values: readonly InkElementV1[]) =>
    cache.digest(createWorkerSnapshot([...values]), async () => undefined);
  await digest(elements);
  await digest([elements[0]!]);
  await digest([extra]);
  const canonicalize = vi.spyOn(canonical, "canonicalElement");
  try {
    await digest([elements[0]!, extra]);
    expect(canonicalize).not.toHaveBeenCalled();
    await digest([elements[1]!]);
    expect(canonicalize).toHaveBeenCalledOnce();
    expect(canonicalize).toHaveBeenCalledWith(elements[1]);
  } finally {
    canonicalize.mockRestore();
  }
});

it("evicts old encoded bytes beyond 32 MiB while keeping the newest maximum-length stroke", async () => {
  const points = Array.from(
    { length: 16_384 * 3 },
    (_, index) => [2000, 999000, 0.9999][index % 3]!,
  );
  Object.freeze(points);
  const elements = Array.from({ length: 120 }, (_, index) =>
    Object.freeze({
      ...createTestStroke(),
      id: elementId(index),
      points,
    }),
  );
  // This is below the file's 2,000,000-point limit but above the canonical-byte cache budget.
  const bytesPerElement = new TextEncoder().encode(
    JSON.stringify(canonical.canonicalElement(elements[0]!)),
  ).byteLength;
  expect(bytesPerElement * elements.length).toBeGreaterThan(32 * 1024 * 1024);
  expect(bytesPerElement * elements.length).toBeLessThan(60 * 1024 * 1024);
  const cache = new CanonicalMetadataCache(Object.isFrozen);
  const digest = (values: readonly InkElementV1[]) =>
    cache.digest(createWorkerSnapshot([...values]), async () => undefined);
  await digest(elements);
  const canonicalize = vi.spyOn(canonical, "canonicalElement");
  try {
    await digest([elements[elements.length - 1]!]);
    expect(canonicalize).not.toHaveBeenCalled();
    await digest([elements[0]!]);
    expect(canonicalize).toHaveBeenCalledOnce();
    expect(canonicalize.mock.calls[0]![0].id).toBe(elements[0]!.id);
  } finally {
    canonicalize.mockRestore();
  }
});

function elementId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}
