import { MAX_STROKE_POINTS } from "../../../src/domain/schema/public";
import { describe, expect, it, vi } from "vitest";
import * as sampleCopy from "../../../src/domain/elements/runtime-sample-copy";
import * as strokeSamples from "../../../src/domain/elements/public";
import { observeSchemaArray } from "../../fixtures/domain/schema-array-work";

import type { StrokeElementV1 } from "../../../src/domain/schema/public";
import { packElementsChunked } from "../../../src/persistence/worker/runtime/element-wire-codec";
import { INKBOOK_CLIPBOARD_TEXT_PREFIX } from "../../../src/persistence/clipboard/constants";
import { adoptUtf8Output } from "../../../src/persistence/scheduling/utf8-adoption";
import {
  encodeRuntimeRequestChunked,
  encodeRuntimeResult,
  decodeRuntimeResultChunked,
} from "../../../src/persistence/worker/runtime/wire-codec";
import { createStandardPersistenceFixture, STANDARD_STROKES, STANDARD_POINTS } from "./fixtures";

const FULL_OUTPUT_BYTES = 48 * 1024 * 1024;
const CLIPBOARD_OUTPUT_BYTES = 5 * 1024 * 1024 + 1;

describe("worker transfer preparation and result adoption", () => {
  it("packs the complete 10,000-stroke request with bounded transfer storage", async () => {
    const snapshot = createStandardPersistenceFixture();
    const checkpoint = vi.fn(async () => undefined);
    const encoded = await encodeRuntimeRequestChunked(
      {
        baseModelRevision: null,
        exportGeneration: 1,
        modelRevision: snapshot.revision,
        sessionId: "wire-performance",
        snapshot,
        type: "export-full",
        workerEpoch: 1,
      },
      { checkpoint, signal: new AbortController().signal },
    );
    expect(encoded.value.type).toBe("export-full-wire");
    expect(encoded.transfer).toHaveLength(STANDARD_STROKES);
    expect(new Set(encoded.transfer).size).toBe(STANDARD_STROKES);
    expect(
      encoded.transfer.reduce<number>(
        (bytes, transfer) => bytes + (transfer instanceof ArrayBuffer ? transfer.byteLength : 0),
        0,
      ),
    ).toBe(STANDARD_POINTS * 3 * Float64Array.BYTES_PER_ELEMENT);
    expect(checkpoint.mock.calls.length).toBeGreaterThanOrEqual(
      Math.floor(snapshot.elements.length / 64),
    );
  });

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

const WORK_CHUNK_BYTES = 256 * 1024;

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
