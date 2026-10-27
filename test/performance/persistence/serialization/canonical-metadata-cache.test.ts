import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { rectangle } from "../../../unit/persistence/worker/runtime/fixtures";
import { expect, it, vi } from "vitest";
import { CanonicalMetadataCache } from "../../../../src/persistence/serialization/metadata/canonical-metadata-cache";
import * as canonical from "../../../../src/persistence/serialization/metadata/canonical-snapshot";
import { serializeCanonicalElementMetadata } from "../../../../src/persistence/serialization/metadata/canonical-element-fragments";
import { canonicalMetadataSha256 } from "../../../../src/persistence/serialization/metadata/canonical-metadata";
import {
  createTestStroke,
  createWorkerSnapshot,
} from "../../../fixtures/persistence/worker-snapshot";

it("serializes only replaced elements across a 10,000-stroke save and releases cached ownership", async () => {
  let pointReads = 0;
  const sampleValues = Array.from({ length: 300 }, (_, index) => [10, 20, 0.5][index % 3]!);
  const elements = Array.from({ length: 10_000 }, (_, index) => {
    const stroke = createTestStroke();
    const samples = trackedSamples(sampleValues, () => pointReads++);
    return Object.freeze({ ...stroke, id: String(index), points: samples });
  });
  const snapshot = createWorkerSnapshot(elements);
  const cache = new CanonicalMetadataCache(Object.isFrozen);
  let checkpoints = 0;
  const checkpoint = () => {
    checkpoints += 1;
    return undefined;
  };
  const canonicalize = vi.spyOn(canonical, "canonicalElement");
  const encode = vi.spyOn(TextEncoder.prototype, "encode");
  const decode = vi.spyOn(TextDecoder.prototype, "decode");
  const sampleText = sampleValues.join(",");
  try {
    const pending = cache.digest(snapshot, checkpoint);
    // The unexpired shared budget admits the complete sample work before any microtask.
    expect(pointReads).toBe(3_000_000);
    expect(decode.mock.calls.length).toBe(0);
    // One document prefix and two header fragments per stroke; samples stay as ASCII bytes.
    expect(encode.mock.calls.length).toBe(20_001);
    const before = await pending;
    expect(pointReads).toBe(3_000_000);
    expect(canonicalize).toHaveBeenCalledTimes(10_000);
    canonicalize.mockClear();
    pointReads = 0;
    checkpoints = 0;
    expect(await cache.digest(snapshot, checkpoint)).toBe(before);
    expect(pointReads).toBe(0);
    expect(canonicalize).not.toHaveBeenCalled();
    expect(checkpoints).toBeLessThanOrEqual(1_000);
    let previous = before;
    for (const offset of [
      { x: 20, y: -10 },
      { x: 40, y: 5 },
    ]) {
      snapshot.revision += 1;
      snapshot.elements[500] = Object.freeze({ ...elements[500]!, offset });
      encode.mockClear();
      const next = await cache.digest(snapshot, checkpoint);
      expect(next).not.toBe(previous);
      expect(pointReads).toBe(0);
      expect(encode.mock.calls.some(([value]) => value === sampleText)).toBe(false);
      expect(canonicalize).toHaveBeenCalledOnce();
      canonicalize.mockClear();
      previous = next;
    }
    snapshot.revision += 1;
    const movedStroke = snapshot.elements[500];
    if (movedStroke?.kind !== "stroke") throw new TypeError("Expected moved stroke.");
    snapshot.elements[500] = Object.freeze({
      ...movedStroke,
      points: trackedSamples(sampleValues, () => pointReads++),
    });
    await cache.digest(snapshot, checkpoint);
    expect(pointReads).toBe(300);
    expect(canonicalize).toHaveBeenCalledOnce();
    cache.clear();
    canonicalize.mockClear();
    pointReads = 0;
    await cache.digest(snapshot, checkpoint);
    expect(pointReads).toBe(3_000_000);
    expect(canonicalize).toHaveBeenCalledTimes(10_000);
  } finally {
    canonicalize.mockRestore();
    encode.mockRestore();
    decode.mockRestore();
  }
});

function trackedSamples(values: readonly number[], onRead: () => void): number[] {
  return new Proxy([...values], {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/u.test(property)) onRead();
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

it("reuses newly encoded shape buffers without copying metadata leaves at 10,000 elements", async () => {
  const elements = Array.from({ length: 10_000 }, (_, index) =>
    Object.freeze({ ...rectangle(), id: elementId(index) }),
  );
  const snapshot = createWorkerSnapshot(elements);
  const expected = canonicalMetadataSha256(snapshot);
  const canonicalTexts = new Set(
    elements.map((element) => serializeCanonicalElementMetadata(element)),
  );
  const encodedBuffers = new WeakSet<ArrayBufferLike>();
  const originalEncode = Reflect.get<TextEncoder, "encode">(TextEncoder.prototype, "encode");
  const originalSet = Reflect.get<Uint8Array, "set">(Uint8Array.prototype, "set");
  let encodedElements = 0;
  let leafCopyBytes = 0;
  const encode = vi.spyOn(TextEncoder.prototype, "encode").mockImplementation(function (
    this: TextEncoder,
    text,
  ) {
    const bytes = originalEncode.call(this, text);
    if (text !== undefined && canonicalTexts.has(text)) {
      encodedBuffers.add(bytes.buffer);
      encodedElements += 1;
    }
    return bytes;
  });
  const copy = vi.spyOn(Uint8Array.prototype, "set").mockImplementation(function (
    this: Uint8Array,
    source,
    offset,
  ) {
    if (
      source instanceof Uint8Array &&
      encodedBuffers.has(source.buffer) &&
      this.byteLength === source.buffer.byteLength
    )
      leafCopyBytes += source.byteLength;
    originalSet.call(this, source, offset);
  });
  const cache = new CanonicalMetadataCache(Object.isFrozen);
  try {
    expect(await cache.digest(snapshot, () => undefined)).toBe(expected);
    expect(encodedElements).toBe(elements.length);
    // Full-document assembly still copies the leaves; only the duplicate leaf buffers disappear.
    expect(leafCopyBytes).toBe(0);
    expect(await cache.digest(snapshot, () => undefined)).toBe(expected);
    expect(encodedElements).toBe(elements.length);
    expect(leafCopyBytes).toBe(0);
  } finally {
    cache.clear();
    encode.mockRestore();
    copy.mockRestore();
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
  const points = Array.from({ length: 16_384 * 3 }, (_, index) => {
    const sign = Math.floor(index / 3) % 2 === 0 ? 1 : -1;
    if (index % 3 === 0) return sign * 999_000;
    if (index % 3 === 1) return sign * 499_000;
    return 0.9999;
  });
  Object.freeze(points);
  const shortPoints = [2000, 999000, 0.9999];
  Object.freeze(shortPoints);
  const elements = Array.from({ length: 15_000 }, (_, index) =>
    Object.freeze({
      ...createTestStroke(),
      id: elementId(index),
      points: index === 0 || index >= 14_881 ? points : shortPoints,
    }),
  );
  // Wide alternating deltas retain the byte-capacity case after compact encoding;
  // 120 maximum-length strokes and 14,880 dots remain below two million points.
  const bytes = (element: InkElementV1) =>
    new TextEncoder().encode(serializeCanonicalElementMetadata(element)).byteLength;
  const metadataBytes = bytes(elements[0]!) * 120 + bytes(elements[1]!) * 14_880;
  expect(metadataBytes).toBeGreaterThan(32 * 1024 * 1024);
  expect(metadataBytes).toBeLessThan(60 * 1024 * 1024);
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
