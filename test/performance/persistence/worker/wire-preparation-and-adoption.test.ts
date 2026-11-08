import { MAX_STROKE_POINTS } from "../../../../src/domain/schema/public";
import { describe, expect, it, vi } from "vitest";
import * as sampleCopy from "../../../../src/domain/elements/runtime-sample-copy";
import * as strokeSamples from "../../../../src/domain/elements/public";
import { observeSchemaArray } from "../../../fixtures/domain/schema-array-work";

import type { StrokeElementV1 } from "../../../../src/domain/schema/public";
import { packElementsChunked } from "../../../../src/persistence/worker/runtime/wire/element-wire-codec";
import { INKBOOK_CLIPBOARD_TEXT_PREFIX } from "../../../../src/persistence/clipboard/constants";
import { adoptUtf8Output } from "../../../../src/persistence/scheduling/utf8-adoption";
import {
  encodeRuntimeRequestChunked,
  decodeRuntimeRequestChunked,
  encodeRuntimeResult,
  decodeRuntimeResultChunked,
} from "../../../../src/persistence/worker/runtime/wire/wire-codec";
import {
  createMaximumStrokeSamples,
  createStandardPersistenceFixture,
  STANDARD_STROKES,
  STANDARD_POINTS,
} from "../fixtures";
import {
  createTestStroke,
  createWorkerSnapshot,
} from "../../../fixtures/persistence/worker-snapshot";

const FULL_OUTPUT_BYTES = 48 * 1024 * 1024;
const CLIPBOARD_OUTPUT_BYTES = 5 * 1024 * 1024 + 1;

describe("worker transfer preparation and result adoption", () => {
  it.each(["export", "model-sync"] as const)(
    "packs the complete 10,000-stroke %s with bounded transfer storage",
    async (kind) => {
      const snapshot = createStandardPersistenceFixture();
      const checkpoint = vi.fn(async () => undefined);
      const common = { baseModelRevision: null, modelRevision: snapshot.revision, snapshot };
      const encoded = await encodeRuntimeRequestChunked(
        kind === "export"
          ? {
              ...common,
              exportGeneration: 1,
              sessionId: "wire-performance",
              type: "export-full",
              workerEpoch: 1,
            }
          : {
              ...common,
              identity: {
                operationId: 1,
                purpose: "background",
                sessionId: "wire-performance",
                workerEpoch: 1,
              },
              type: "model-sync-full",
            },
        { checkpoint, signal: new AbortController().signal },
      );
      expect(encoded.value.type).toBe(
        kind === "export" ? "export-full-wire" : "model-sync-full-wire",
      );
      const transfers = kind === "export" ? STANDARD_STROKES : 2;
      expect(encoded.transfer).toHaveLength(transfers);
      expect(new Set(encoded.transfer).size).toBe(transfers);
      expect(
        encoded.transfer.reduce<number>(
          (bytes, transfer) => bytes + (transfer instanceof ArrayBuffer ? transfer.byteLength : 0),
          0,
        ),
      ).toBe(
        STANDARD_POINTS * 3 * Float64Array.BYTES_PER_ELEMENT +
          (kind === "model-sync" ? STANDARD_STROKES * Uint32Array.BYTES_PER_ELEMENT : 0),
      );
      expect(checkpoint.mock.calls.length).toBeGreaterThanOrEqual(
        Math.floor(snapshot.elements.length / 64),
      );
      if (kind === "model-sync") await assertPrivateModelSamples(encoded, snapshot);
    },
  );

  it("transfers only one canonical clipboard representation and adopts it in chunks", async () => {
    const customText = "a".repeat(CLIPBOARD_OUTPUT_BYTES);
    const plainText = `${INKBOOK_CLIPBOARD_TEXT_PREFIX}${customText}`;
    const encoded = encodeRuntimeResult({
      identity: {
        operationId: 1,
        purpose: "clipboard",
        sessionId: "wire-performance",
        workerEpoch: 1,
      },
      result: { ok: true, value: { byteLength: customText.length, customText, plainText } },
      type: "clipboard-encode-success",
    });
    expect(encoded.transfer).toHaveLength(1);
    const received = structuredClone(encoded.value, { transfer: [...encoded.transfer] });
    if (encoded.value.type !== "clipboard-encode-success-wire" || !encoded.value.result.ok) {
      throw new Error("Expected an encoded clipboard wire result.");
    }
    expect(encoded.value.result.value.canonicalText.byteLength).toBe(0);
    const checkpoint = vi.fn(async () => undefined);
    const adopted = await decodeRuntimeResultChunked(received, {
      checkpoint,
      signal: new AbortController().signal,
    });
    expect(adopted).toMatchObject({
      result: { ok: true, value: { customText, plainText } },
      type: "clipboard-encode-success",
    });
    expect(checkpoint).toHaveBeenCalledTimes(
      Math.ceil(CLIPBOARD_OUTPUT_BYTES / WORK_CHUNK_BYTES) + 2,
    );
  });

  it("detaches transferred UTF-8 storage while preserving the full decoded output", () => {
    const output = "a".repeat(8 * 1024 * 1024);
    expect(structuredClone(output)).toBe(output);
    const encoded = new TextEncoder().encode(output);
    const transferred = structuredClone(encoded, { transfer: [encoded.buffer] });
    expect(encoded.byteLength).toBe(0);
    expect(transferred.byteLength).toBe(output.length);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(transferred)).toBe(output);
  });
});

async function assertPrivateModelSamples(
  encoded: Awaited<ReturnType<typeof encodeRuntimeRequestChunked>>,
  source: ReturnType<typeof createStandardPersistenceFixture>,
) {
  const received = structuredClone(encoded.value, { transfer: [...encoded.transfer] });
  for (const transfer of encoded.transfer) {
    if (!(transfer instanceof ArrayBuffer)) throw new Error("Expected an ArrayBuffer transfer.");
    expect(transfer.byteLength).toBe(0);
  }
  const decoded = await decodeRuntimeRequestChunked(received, {
    checkpoint: () => undefined,
    signal: new AbortController().signal,
  });
  if (decoded.type !== "model-sync-full") throw new Error("Expected a full model synchronization.");
  expect(decoded.snapshot.elements.map(({ id }) => id)).toEqual(
    source.elements.map(({ id }) => id),
  );
  const strokes = decoded.snapshot.elements.filter((element) => element.kind === "stroke");
  const originals = source.elements.filter((element) => element.kind === "stroke");
  expect(strokes).toHaveLength(STANDARD_STROKES);
  const buffers = new Set<ArrayBufferLike>();
  for (const stroke of strokes) {
    if (!(stroke.points instanceof Float64Array))
      throw new Error("Expected private native samples.");
    expect(stroke.points.byteOffset).toBe(0);
    expect(stroke.points.buffer.byteLength).toBe(stroke.points.byteLength);
    buffers.add(stroke.points.buffer);
  }
  expect(buffers.size).toBe(STANDARD_STROKES);
  for (const rank of [0, 5000, 9999])
    expect(Array.from(strokes[rank]!.points)).toEqual(Array.from(originals[rank]!.points));
}

const WORK_CHUNK_BYTES = 256 * 1024;

function longArenaRequest() {
  const maximum = Array.from(createMaximumStrokeSamples());
  const elements = Array.from({ length: 129 }, (_, index) => ({
    ...createTestStroke(),
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    points: index === 0 ? maximum : [10, 10, 0.5, 20, 20, 1],
  }));
  return {
    type: "model-sync-full" as const,
    baseModelRevision: null,
    modelRevision: 0,
    identity: {
      sessionId: "long-arena",
      workerEpoch: 1,
      operationId: 1,
      purpose: "background" as const,
    },
    snapshot: createWorkerSnapshot(elements),
  };
}

function observeArenaCopies() {
  const nativeSet = Object.getOwnPropertyDescriptor(
    Reflect.getPrototypeOf(Float64Array.prototype)!,
    "set",
  )!.value as Float64Array["set"];
  let totalBytes = 0;
  let pendingBytes = 0;
  const copy = vi.spyOn(Float64Array.prototype, "set").mockImplementation(function (
    this: Float64Array,
    source,
    offset,
  ) {
    const bytes = source.length * Float64Array.BYTES_PER_ELEMENT;
    // One indivisible typed-array copy stays within 64 KiB.
    expect(bytes).toBeLessThanOrEqual(64 * 1024);
    totalBytes += bytes;
    pendingBytes += bytes;
    nativeSet.call(this, source, offset);
  });
  return {
    totalBytes: () => totalBytes,
    checkpoint: () => {
      // Include the long stroke's final copy and following short peers in one admission.
      expect(pendingBytes).toBeLessThanOrEqual(72 * 1024);
      pendingBytes = 0;
      return undefined;
    },
    restore: () => copy.mockRestore(),
  };
}

it.each(["encode", "decode"] as const)(
  "bounds actual long-stroke arena %s bytes through the complete wire pipeline",
  async (phase) => {
    const request = longArenaRequest();
    const context = { checkpoint: () => undefined, signal: new AbortController().signal };
    const prepared =
      phase === "decode" ? await encodeRuntimeRequestChunked(request, context) : undefined;
    const observed = observeArenaCopies();
    let encoded = prepared;
    let decoded;
    try {
      const options = { ...context, checkpoint: observed.checkpoint };
      if (phase === "encode") encoded = await encodeRuntimeRequestChunked(request, options);
      else decoded = await decodeRuntimeRequestChunked(prepared!.value, options);
      observed.checkpoint();
      const values = request.snapshot.elements.reduce(
        (total, element) => total + (element.kind === "stroke" ? element.points.length : 0),
        0,
      );
      // Each phase copies every point value once, including the final non-checkpointed tail.
      expect(observed.totalBytes()).toBe(values * Float64Array.BYTES_PER_ELEMENT);
    } finally {
      observed.restore();
    }
    expect(encoded!.transfer).toHaveLength(2);
    decoded ??= await decodeRuntimeRequestChunked(
      structuredClone(encoded!.value, { transfer: [...encoded!.transfer] }),
      context,
    );
    if (decoded.type !== "model-sync-full") throw new Error("Expected a decoded model.");
    const buffers = new Set<ArrayBufferLike>();
    for (const [index, element] of decoded.snapshot.elements.entries()) {
      const expected = request.snapshot.elements[index];
      if (expected?.kind !== "stroke") throw new Error("Expected a source stroke.");
      if (element.kind !== "stroke" || !(element.points instanceof Float64Array))
        throw new Error("Expected private native stroke points.");
      expect(Array.from(element.points)).toEqual(expected.points);
      expect(element.points.byteOffset).toBe(0);
      expect(element.points.byteLength).toBe(element.points.buffer.byteLength);
      buffers.add(element.points.buffer);
    }
    expect(buffers.size).toBe(129);
  },
);

it.each(["encode", "decode"] as const)(
  "aborts arena %s inside a maximum stroke without publishing or copying its remainder",
  async (phase) => {
    const request = longArenaRequest();
    const controller = new AbortController();
    const context = { checkpoint: () => undefined, signal: controller.signal };
    const prepared =
      phase === "decode" ? await encodeRuntimeRequestChunked(request, context) : undefined;
    const observed = observeArenaCopies();
    let bytesAtAbort = 0;
    try {
      const options = {
        signal: controller.signal,
        checkpoint: () => {
          observed.checkpoint();
          if (observed.totalBytes() > 0 && !controller.signal.aborted) {
            bytesAtAbort = observed.totalBytes();
            controller.abort(new Error("Cancelled long arena copy."));
          }
          return undefined;
        },
      };
      await expect(
        phase === "encode"
          ? encodeRuntimeRequestChunked(request, options)
          : decodeRuntimeRequestChunked(prepared!.value, options),
      ).rejects.toThrow("Cancelled long arena copy.");
      observed.checkpoint();
      expect(bytesAtAbort).toBeGreaterThan(0);
      expect(bytesAtAbort).toBeLessThan(MAX_STROKE_POINTS * 3 * Float64Array.BYTES_PER_ELEMENT);
      expect(observed.totalBytes()).toBe(bytesAtAbort);
    } finally {
      observed.restore();
    }
  },
);

describe("wire preparation deterministic work bounds", () => {
  it("bounds actual decoder input between checkpoints and flushes exactly once", async () => {
    const expected =
      "a".repeat(WORK_CHUNK_BYTES - 1) + "€" + "b".repeat(FULL_OUTPUT_BYTES - WORK_CHUNK_BYTES - 2);
    const output = new TextEncoder().encode(expected);
    const decode = Object.getOwnPropertyDescriptor(TextDecoder.prototype, "decode")!
      .value as TextDecoder["decode"];
    const calls: { bytes: number; stream: boolean | undefined }[] = [];
    let totalBytes = 0;
    let checkpoints = 0;
    let flushes = 0;
    const spy = vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (
      this: TextDecoder,
      input,
      options,
    ) {
      const bytes = input?.byteLength ?? 0;
      calls.push({ bytes, stream: options?.stream });
      totalBytes += bytes;
      if (input === undefined) flushes += 1;
      return decode.call(this, input, options);
    });
    try {
      const adopted = await adoptUtf8Output(output, {
        checkpoint: async () => {
          expect(calls).toHaveLength(checkpoints === 0 ? 0 : 1);
          if (checkpoints > 0) {
            expect(calls[0]!.bytes).toBeLessThanOrEqual(WORK_CHUNK_BYTES);
            if (totalBytes < output.byteLength) expect(calls[0]!.stream).toBe(true);
            else expect(calls[0]!.stream).not.toBe(true);
          }
          calls.length = 0;
          checkpoints += 1;
        },
      });
      expect(adopted).toBe(expected);
      expect(totalBytes).toBe(FULL_OUTPUT_BYTES);
      expect(flushes).toBe(1);
      expect(checkpoints).toBe(Math.ceil(output.byteLength / WORK_CHUNK_BYTES) + 2);
      expect(calls).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    { elements: 129, points: 1, expectedSlices: 260 },
    { elements: 7, points: MAX_STROKE_POINTS, expectedSlices: 1344 },
  ])(
    "bounds observed packing work for $elements strokes of $points points",
    async ({ elements, points, expectedSlices }) => {
      const observed = observedPackingInput(elements, points);
      const slices: ReturnType<typeof observed.capture>[] = [];
      const checkpoint = (): undefined => {
        const slice = observed.capture();
        slices.push(slice);
        expect(slice.elements).toBeLessThanOrEqual(1);
        expect(slice.bytes).toBeLessThanOrEqual(768 * Float64Array.BYTES_PER_ELEMENT);
        expect(slice.pointReads).toBeLessThanOrEqual(768);
        // Enumerable-key inspection reads each descriptor for for-in and own-key validation.
        expect(slice.descriptorReads).toBeLessThanOrEqual(2 * 768);
        expect(slice.validatedValues).toBeLessThanOrEqual(768);
        return undefined;
      };
      try {
        const packing = packElementsChunked(observed.elements, {
          checkpoint,
          signal: new AbortController().signal,
        });
        // A free shared budget drains bounded units without a forced asynchronous handoff.
        const inlineSlices = slices.length;
        const packed = await packing;
        expect(inlineSlices).toBe(expectedSlices);
        checkpoint();
        expect(slices.reduce((sum, slice) => sum + slice.elements, 0)).toBe(elements);
        expect(slices.reduce((sum, slice) => sum + slice.bytes, 0)).toBe(elements * points * 24);
        expect(slices.reduce((sum, slice) => sum + slice.pointReads, 0)).toBe(
          elements * points * 3,
        );
        expect(slices.reduce((sum, slice) => sum + slice.descriptorReads, 0)).toBe(
          elements * points * 9,
        );
        expect(slices.reduce((sum, slice) => sum + slice.validatedValues, 0)).toBe(
          elements * points * 3,
        );
        expect(packed.records).toHaveLength(elements);
        expect(packed.pointBuffers).toHaveLength(elements);
        for (const [index, buffer] of packed.pointBuffers.entries()) {
          expect(packed.records[index]).toMatchObject({
            id: `stroke-${index}`,
            pointsBufferIndex: index,
          });
          expect(Array.from(buffer)).toEqual(observed.samples);
        }
      } finally {
        observed.restore();
      }
    },
  );
});

function observedPackingInput(elementCount: number, pointCount: number) {
  const samples = Array.from({ length: pointCount * 3 }, (_, index) => (index % 3 === 2 ? 1 : 0));
  const { observed: points, work } = observeSchemaArray(samples);
  let copiedBytes = 0;
  let validatedValues = 0;
  const copyRange = sampleCopy.copySampleRange;
  const copying = vi
    .spyOn(sampleCopy, "copySampleRange")
    .mockImplementation((source, target, start, end, proof) => {
      copiedBytes += (end - start) * Float64Array.BYTES_PER_ELEMENT;
      copyRange(source, target, start, end, proof);
    });
  const assertSamples = strokeSamples.assertStrokeSamplesV1;
  const validation = vi
    .spyOn(strokeSamples, "assertStrokeSamplesV1")
    .mockImplementation((values) => {
      validatedValues += values.length;
      assertSamples(values);
    });
  let elementReads = 0;
  let nextIndex = 0;
  const strokes: StrokeElementV1[] = Array.from({ length: elementCount }, (_, index) => ({
    id: `stroke-${index}`,
    kind: "stroke",
    createdAt: index,
    rotation: 0,
    pivot: { x: 0, y: 0 },
    tool: "pen",
    points,
    style: {
      color: { type: "theme-text" },
      opacity: 1,
      pressureEnabled: false,
      smoothing: 0.5,
      width: 4,
    },
  }));
  const elements = new Proxy(strokes, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) {
        expect(Number(property)).toBe(nextIndex++);
        elementReads += 1;
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  return {
    elements,
    samples,
    capture: () => {
      const result = {
        elements: elementReads,
        bytes: copiedBytes,
        pointReads: work.indexedReads,
        descriptorReads: work.descriptorReads,
        validatedValues,
      };
      elementReads = 0;
      copiedBytes = 0;
      validatedValues = 0;
      work.indexedReads = 0;
      work.descriptorReads = 0;
      return result;
    },
    restore: () => {
      copying.mockRestore();
      validation.mockRestore();
    },
  };
}
