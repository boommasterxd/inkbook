import { afterEach, expect, it, vi } from "vitest";
import {
  FILE_SCHEMA_LIMITS,
  MAX_STROKE_POINTS,
} from "../../../../../../src/domain/schema/constants";
import {
  encodeModelSyncRequest,
  encodeModelSyncRequestChunked,
} from "../../../../../../src/persistence/worker/runtime/wire/model-sync-wire";
import { decodeRuntimeRequestChunked } from "../../../../../../src/persistence/worker/runtime/wire/request-wire-decoding";
import type { ModelSyncPointArenaEnvelope } from "../../../../../../src/persistence/worker/runtime/wire/model-sync-point-arena";
import type { FullModelSyncRuntimeRequest } from "../../../../../../src/persistence/worker/runtime/types";
import type { StrokeElementV1 } from "../../../../../../src/domain/schema/public";
import {
  createTestStroke,
  createWorkerSnapshot,
} from "../../../../../fixtures/persistence/worker-snapshot";

afterEach(() => vi.unstubAllGlobals());

function strokes(count: number): StrokeElementV1[] {
  return Array.from({ length: count }, (_, index) => ({
    ...createTestStroke(),
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    points: [index, 10, 0.5, index + 1, 20, 1],
  }));
}

function fullRequest(elements = strokes(129)): FullModelSyncRuntimeRequest {
  return {
    baseModelRevision: null,
    identity: { sessionId: "arena", workerEpoch: 1, operationId: 1, purpose: "background" },
    modelRevision: 0,
    snapshot: createWorkerSnapshot(elements),
    type: "model-sync-full",
  };
}

function context(checkpoint = () => undefined as Promise<void> | undefined) {
  return { checkpoint, signal: new AbortController().signal };
}

function fullArena() {
  const encoded = encodeModelSyncRequest(fullRequest());
  const value = encoded.value;
  if (value.type !== "model-sync-full-wire" || !("format" in value.snapshot.elements))
    throw new Error("Expected a full point-arena request.");
  return { encoded, value, arena: value.snapshot.elements };
}

it.each([false, true])(
  "round-trips large model sync with two owned transfers, chunked=%s",
  async (chunked) => {
    const elements = strokes(129);
    const request = fullRequest(elements);
    const encoded = chunked
      ? await encodeModelSyncRequestChunked(request, context())
      : encodeModelSyncRequest(request);
    expect(encoded.transfer).toHaveLength(2);
    const transferred = structuredClone(encoded.value, { transfer: [...encoded.transfer] });
    if (transferred.type !== "model-sync-full-wire" || !("format" in transferred.snapshot.elements))
      throw new Error("Expected an arena after native structured cloning.");
    const arena = transferred.snapshot.elements;
    expect(arena.format).toBe("point-arena");
    expect(arena.pointArena.length).toBe(129 * 6);
    expect(arena.pointLengths.length).toBe(129);
    const decoded = await decodeRuntimeRequestChunked(transferred, context());
    if (decoded.type !== "model-sync-full") throw new Error("Expected full model sync.");
    const buffers = new Set<ArrayBufferLike>();
    for (const [index, element] of decoded.snapshot.elements.entries()) {
      if (element.kind !== "stroke") throw new Error("Expected pressure ink.");
      const points = element.points as unknown as Float64Array;
      expect(points).toBeInstanceOf(Float64Array);
      expect(points.byteOffset).toBe(0);
      expect(points.byteLength).toBe(points.buffer.byteLength);
      expect(points.buffer).not.toBe(arena.pointArena.buffer);
      expect(Array.from(points)).toEqual(elements[index]!.points);
      buffers.add(points.buffer);
    }
    expect(buffers.size).toBe(129);
    expect(elements[0]!.points).toEqual([0, 10, 0.5, 1, 20, 1]);
  },
);

it("keeps the 128-buffer boundary and reference-only or absent deltas in the legacy format", async () => {
  const encoded = encodeModelSyncRequest(fullRequest(strokes(128)));
  expect(encoded.transfer).toHaveLength(128);
  if (encoded.value.type !== "model-sync-full-wire") throw new Error("Expected full model sync.");
  expect(encoded.value.snapshot.elements).toHaveProperty("pointBuffers");
  const request = {
    baseModelRevision: 0,
    changedElements: strokes(129),
    identity: fullRequest().identity,
    modelRevision: 1,
    type: "model-sync-incremental" as const,
  };
  const reused = await encodeModelSyncRequestChunked(request, {
    ...context(),
    reusePoints: () => true,
  });
  expect(reused.transfer).toHaveLength(0);
  if (reused.value.type !== "model-sync-incremental-wire") throw new Error("Expected a delta.");
  expect(reused.value.changedElements).toHaveProperty("pointBuffers", []);
  const { changedElements: _changed, ...absent } = request;
  const empty = encodeModelSyncRequest(absent);
  expect(empty).toMatchObject({
    transfer: [],
    value: { ...absent, type: "model-sync-incremental-wire" },
  });
  expect(empty.value).not.toHaveProperty("changedElements");
});

it("preserves current and retired point references alongside arena-owned delta buffers", async () => {
  const elements = strokes(131);
  const current = new Float64Array(elements[129]!.points);
  const retired = new Float64Array(elements[130]!.points);
  const encoded = await encodeModelSyncRequestChunked(
    {
      baseModelRevision: 0,
      changedElements: elements,
      identity: fullRequest().identity,
      modelRevision: 1,
      type: "model-sync-incremental",
    },
    {
      ...context(),
      reusePoints: (element) =>
        element.id === elements[129]!.id
          ? true
          : element.id === elements[130]!.id
            ? "retired"
            : false,
    },
  );
  expect(encoded.transfer).toHaveLength(2);
  const resolve = vi.fn((id: string, wasRetired?: boolean) => {
    expect(id).toBe(wasRetired ? elements[130]!.id : elements[129]!.id);
    return (wasRetired ? retired : current) as unknown as StrokeElementV1["points"];
  });
  const decoded = await decodeRuntimeRequestChunked(encoded.value, context(), resolve);
  if (decoded.type !== "model-sync-incremental") throw new Error("Expected a model delta.");
  const values = decoded.changedElements! as readonly StrokeElementV1[];
  expect(values[129]!.points).toBe(current);
  expect(values[130]!.points).toBe(retired);
  expect(resolve).toHaveBeenCalledTimes(2);
});

const malformed: Array<[string, (arena: ModelSyncPointArenaEnvelope) => unknown]> = [
  ["wrong tag", (arena) => ({ ...arena, format: "other" })],
  ["non-array records", (arena) => ({ ...arena, records: {} })],
  ["wrong point brand", (arena) => ({ ...arena, pointArena: new Float32Array(arena.pointArena) })],
  [
    "spoofed point brand",
    (arena) => {
      const pointArena = new Float32Array(arena.pointArena);
      Object.defineProperty(pointArena, Symbol.toStringTag, { value: "Float64Array" });
      return { ...arena, pointArena };
    },
  ],
  ["proxied points", (arena) => ({ ...arena, pointArena: new Proxy(arena.pointArena, {}) })],
  [
    "wrong length brand",
    (arena) => ({ ...arena, pointLengths: new Uint16Array(arena.pointLengths) }),
  ],
  ["proxied lengths", (arena) => ({ ...arena, pointLengths: new Proxy(arena.pointLengths, {}) })],
  [
    "partial points",
    (arena) => ({
      ...arena,
      pointArena: new Float64Array(new ArrayBuffer(arena.pointArena.byteLength + 8), 8),
    }),
  ],
  [
    "spoofed partial span",
    (arena) => {
      const pointArena = new Float64Array(new ArrayBuffer(arena.pointArena.byteLength + 8), 8);
      Object.defineProperties(pointArena, {
        byteOffset: { value: 0 },
        byteLength: { value: pointArena.buffer.byteLength },
      });
      return { ...arena, pointArena };
    },
  ],
  [
    "partial lengths",
    (arena) => ({
      ...arena,
      pointLengths: new Uint32Array(new ArrayBuffer(arena.pointLengths.byteLength + 4), 4),
    }),
  ],
  [
    "shared points",
    (arena) => ({
      ...arena,
      pointArena: new Float64Array(new SharedArrayBuffer(arena.pointArena.byteLength)),
    }),
  ],
  [
    "shared lengths",
    (arena) => ({
      ...arena,
      pointLengths: new Uint32Array(new SharedArrayBuffer(arena.pointLengths.byteLength)),
    }),
  ],
  [
    "aliased stores",
    (arena) => ({ ...arena, pointLengths: new Uint32Array(arena.pointArena.buffer) }),
  ],
  [
    "excess count",
    (arena) => ({ ...arena, pointLengths: new Uint32Array(arena.records.length + 1) }),
  ],
  [
    "excess records",
    (arena) => ({
      ...arena,
      records: new Array(FILE_SCHEMA_LIMITS.elements + 1).fill(arena.records[0]),
    }),
  ],
  [
    "excess point bytes",
    (arena) => ({
      ...arena,
      pointArena: new Float64Array(FILE_SCHEMA_LIMITS.strokePoints * 3 + 3),
    }),
  ],
  [
    "invalid stroke length",
    (arena) => ({
      ...arena,
      pointLengths: new Uint32Array(arena.pointLengths.length).fill(MAX_STROKE_POINTS * 3 + 3),
    }),
  ],
  [
    "non-triple length",
    (arena) => ({ ...arena, pointLengths: new Uint32Array(arena.pointLengths.length).fill(4) }),
  ],
  [
    "zero length",
    (arena) => ({ ...arena, pointLengths: new Uint32Array(arena.pointLengths.length) }),
  ],
  [
    "unconsumed arena",
    (arena) => ({ ...arena, pointLengths: new Uint32Array(arena.pointLengths.length).fill(3) }),
  ],
  [
    "excess aggregate",
    (arena) => ({
      ...arena,
      pointArena: new Float64Array(),
      pointLengths: new Uint32Array(arena.pointLengths.length).fill(MAX_STROKE_POINTS * 3),
    }),
  ],
];

it.each(malformed)(
  "rejects %s before allocating any private stroke buffer",
  async (_label, mutate) => {
    const { value, arena } = fullArena();
    const elements = mutate(arena);
    const NativeArray = Float64Array;
    const allocations: number[] = [];
    vi.stubGlobal(
      "Float64Array",
      class extends NativeArray {
        constructor(source: number | ArrayBuffer, offset?: number, length?: number) {
          if (typeof source === "number") {
            super(source);
            allocations.push(source);
          } else super(source, offset, length);
        }
      },
    );
    await expect(
      decodeRuntimeRequestChunked(
        { ...value, snapshot: { ...value.snapshot, elements } },
        context(),
      ),
    ).rejects.toThrow();
    expect(allocations).toEqual([]);
  },
);

it("captures length metadata before cooperative decoding can change its source", async () => {
  const { value, arena } = fullArena();
  let changed = false;
  const decoded = await decodeRuntimeRequestChunked(
    value,
    context(() => {
      if (!changed) {
        changed = true;
        arena.pointLengths.fill(0xffffffff);
      }
      return undefined;
    }),
  );
  expect(changed).toBe(true);
  if (decoded.type !== "model-sync-full") throw new Error("Expected full model sync.");
  expect(decoded.snapshot.elements).toHaveLength(129);
  expect((decoded.snapshot.elements[128] as StrokeElementV1).points).toHaveLength(6);
});

it.each(["encode", "decode"] as const)(
  "cancels %s during cooperative point copying without returning a partial request",
  async (phase) => {
    const { value } = fullArena();
    const request = fullRequest();
    const controller = new AbortController();
    const copy = vi.spyOn(Float64Array.prototype, "set");
    let atAbort = 0;
    const options = {
      signal: controller.signal,
      checkpoint: () => {
        if (copy.mock.calls.length > 0 && !controller.signal.aborted) {
          atAbort = copy.mock.calls.length;
          controller.abort(new Error("Cancelled arena copy."));
        }
        return undefined;
      },
    };
    try {
      await expect(
        phase === "encode"
          ? encodeModelSyncRequestChunked(request, options)
          : decodeRuntimeRequestChunked(value, options),
      ).rejects.toThrow("Cancelled arena copy.");
      expect(atAbort).toBeGreaterThan(0);
      expect(atAbort).toBeLessThan(129);
      expect(copy).toHaveBeenCalledTimes(atAbort);
    } finally {
      copy.mockRestore();
    }
  },
);
