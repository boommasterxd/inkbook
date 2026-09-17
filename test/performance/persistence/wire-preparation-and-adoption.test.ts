import { describe, expect, it, vi } from "vitest";

import type { StrokeElementV1 } from "../../../src/domain/schema/public";
import { packElementsChunked } from "../../../src/persistence/worker/runtime/element-wire-codec";

import { INKBOOK_CLIPBOARD_TEXT_PREFIX } from "../../../src/persistence/clipboard/constants";
import { yieldToMainThread } from "../../../src/persistence/scheduling/main-thread-yield";
import { adoptUtf8Output } from "../../../src/persistence/scheduling/utf8-adoption";
import {
  encodeRuntimeRequestChunked,
  encodeRuntimeResult,
} from "../../../src/persistence/worker/runtime/wire-codec";
import { decodeRuntimeResultChunked } from "../../../src/persistence/worker/runtime/wire-codec";
import { INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";
import { recordRelativeTiming } from "../timing-assertions";
import { performanceMode } from "../timing-budget";
import { createStandardPersistenceFixture, STANDARD_STROKES } from "./fixtures";
import {
  annotateDurations,
  collectProfileGarbage,
  expectProfileBudget,
  summarizeDurations,
} from "./metrics";

const AUTOSAVE_MAIN_THREAD_BUDGET_MS = INTERACTION_REFRESH_PROFILE.mainThreadP99Ms;
const FULL_OUTPUT_BYTES = 48 * 1024 * 1024;
const CLIPBOARD_OUTPUT_BYTES = 5 * 1024 * 1024 + 1;
const WIRE_REFERENCE_BYTES = 8 * 1024 * 1024;

describe("worker transfer preparation and result adoption", () => {
  it("packs the 10,000-stroke full request in bounded main-thread slices", async ({ annotate }) => {
    const snapshot = createStandardPersistenceFixture();
    await measureFullRequestPacking(snapshot);
    const measurements: SliceMeasurement[] = [];
    for (let run = 0; run < 5; run += 1) {
      measurements.push(await measureFullRequestPacking(snapshot));
    }

    const sliceDurations = measurements.map(({ maximumSliceMs }) => maximumSliceMs);
    await annotateDurations(
      annotate,
      "full request main-thread preparation slices",
      sliceDurations,
    );
    await annotateDurations(
      annotate,
      "full request main-thread preparation total",
      measurements.map(({ totalMs }) => totalMs),
    );
    await annotate(
      `full request transfer: buffers=${STANDARD_STROKES}, ` +
        `pointBytes=${measurements[0]?.transferredBytes ?? 0}`,
      "performance",
    );
    expectProfileBudget(sliceDurations, AUTOSAVE_MAIN_THREAD_BUDGET_MS);
    recordRelativeTiming(
      Math.max(...measurements.map(({ activeMs }) => activeMs)),
      "full request packing active-slice elapsed time",
    );
  }, 120_000);

  it("adopts a maximum-size UTF-8 result in bounded main-thread slices", async ({ annotate }) => {
    const output = new Uint8Array(FULL_OUTPUT_BYTES);
    output.fill(97);
    await measureUtf8Adoption(output);
    const measurements: SliceMeasurement[] = [];
    for (let run = 0; run < 5; run += 1) {
      collectProfileGarbage();
      measurements.push(await measureUtf8Adoption(output));
    }

    const sliceDurations = measurements.map(({ maximumSliceMs }) => maximumSliceMs);
    await annotateDurations(annotate, "UTF-8 result adoption slices", sliceDurations);
    await annotateDurations(
      annotate,
      "UTF-8 result adoption total",
      measurements.map(({ totalMs }) => totalMs),
    );
    expectProfileBudget(sliceDurations, AUTOSAVE_MAIN_THREAD_BUDGET_MS);
    recordRelativeTiming(
      Math.max(...measurements.map(({ activeMs }) => activeMs)),
      "UTF-8 adoption active-slice elapsed time",
    );
  }, 120_000);

  it("adopts one canonical clipboard representation in bounded slices", async ({ annotate }) => {
    const customText = "a".repeat(CLIPBOARD_OUTPUT_BYTES);
    await measureClipboardAdoption(customText);
    const measurements: SliceMeasurement[] = [];
    for (let run = 0; run < 5; run += 1) {
      collectProfileGarbage();
      measurements.push(await measureClipboardAdoption(customText));
    }

    const sliceDurations = measurements.map(({ maximumSliceMs }) => maximumSliceMs);
    await annotateDurations(annotate, "clipboard result adoption slices", sliceDurations);
    await annotateDurations(
      annotate,
      "clipboard result adoption total",
      measurements.map(({ totalMs }) => totalMs),
    );
    expectProfileBudget(sliceDurations, AUTOSAVE_MAIN_THREAD_BUDGET_MS);
    recordRelativeTiming(
      Math.max(...measurements.map(({ activeMs }) => activeMs)),
      "clipboard adoption active-slice elapsed time",
    );
  }, 120_000);
});

describe("reference wire-format comparison", () => {
  for (const profile of ["desktop", "mobile"] as const) {
    it(`compares cloned strings and transferred UTF-8 for the ${profile} reference`, async ({
      annotate,
    }) => {
      const output = "a".repeat(WIRE_REFERENCE_BYTES);
      const cloneFirst = profile === "desktop";
      compareWireFormats(output, cloneFirst);
      const cloned: number[] = [];
      const transferred: number[] = [];
      for (let run = 0; run < 5; run += 1) {
        const measurement = compareWireFormats(output, run % 2 === 0 ? cloneFirst : !cloneFirst);
        cloned.push(measurement.clonedStringMs);
        transferred.push(measurement.transferredUtf8Ms);
      }

      await annotateDurations(annotate, `${profile} cloned string wire`, cloned);
      await annotateDurations(annotate, `${profile} transferred UTF-8 wire`, transferred);
      // Wire-format selection is a reference-device obligation, not a PR-source regression.
      if (performanceMode() === "reference") {
        expect(summarizeDurations(transferred).p50).toBeLessThan(summarizeDurations(cloned).p50);
      }
    }, 120_000);
  }
});

interface SliceMeasurement {
  readonly activeMs: number;
  readonly maximumSliceMs: number;
  readonly totalMs: number;
  readonly transferredBytes?: number;
}

function compareWireFormats(
  output: string,
  cloneFirst: boolean,
): {
  readonly clonedStringMs: number;
  readonly transferredUtf8Ms: number;
} {
  const [cloned, transferred] = cloneFirst
    ? ([measureClonedString(output), measureTransferredUtf8(output)] as const)
    : reverseWireMeasurements(output);
  expect(cloned.length).toBe(output.length);
  expect(transferred.senderBytes).toBe(0);
  expect(transferred.length).toBe(output.length);
  return { clonedStringMs: cloned.durationMs, transferredUtf8Ms: transferred.durationMs };
}

function reverseWireMeasurements(output: string) {
  const transferred = measureTransferredUtf8(output);
  return [measureClonedString(output), transferred] as const;
}

function measureClonedString(output: string) {
  const started = performance.now();
  const cloned = structuredClone(output);
  const durationMs = performance.now() - started;
  return { durationMs, length: cloned.length };
}

function measureTransferredUtf8(output: string) {
  const started = performance.now();
  const encoded = new TextEncoder().encode(output);
  const transferred = structuredClone(encoded, { transfer: [encoded.buffer] });
  const adopted = new TextDecoder("utf-8", { fatal: true }).decode(transferred);
  const durationMs = performance.now() - started;
  return { durationMs, length: adopted.length, senderBytes: encoded.byteLength };
}

async function measureFullRequestPacking(
  snapshot: ReturnType<typeof createStandardPersistenceFixture>,
): Promise<SliceMeasurement> {
  const slices = measuredCheckpoint();
  const started = performance.now();
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
    { checkpoint: slices.checkpoint, signal: new AbortController().signal },
  );
  slices.finish();
  const totalMs = performance.now() - started;
  expect(encoded.value.type).toBe("export-full-wire");
  expect(encoded.transfer).toHaveLength(STANDARD_STROKES);
  return {
    activeMs: slices.durations.reduce((total, duration) => total + duration, 0),
    maximumSliceMs: summarizeDurations(slices.durations).maximum,
    totalMs,
    transferredBytes: encoded.transfer.reduce<number>(
      (bytes, transferable) =>
        bytes + (transferable instanceof ArrayBuffer ? transferable.byteLength : 0),
      0,
    ),
  };
}

async function measureUtf8Adoption(output: Uint8Array): Promise<SliceMeasurement> {
  const slices = measuredCheckpoint({ betweenSlices: yieldToMainThread });
  const started = performance.now();
  const adopted = await adoptUtf8Output(output, { checkpoint: slices.checkpoint });
  slices.finish();
  const totalMs = performance.now() - started;
  expect(adopted.length).toBe(output.byteLength);
  expect(adopted.charCodeAt(0)).toBe(97);
  expect(adopted.charCodeAt(adopted.length - 1)).toBe(97);
  return {
    activeMs: slices.durations.reduce((total, duration) => total + duration, 0),
    maximumSliceMs: summarizeDurations(slices.durations).maximum,
    totalMs,
  };
}

async function measureClipboardAdoption(customText: string): Promise<SliceMeasurement> {
  const encoded = encodeRuntimeResult({
    identity: {
      operationId: 1,
      purpose: "clipboard",
      sessionId: "wire-performance",
      workerEpoch: 1,
    },
    result: {
      ok: true,
      value: {
        byteLength: customText.length,
        customText,
        plainText: `${INKBOOK_CLIPBOARD_TEXT_PREFIX}${customText}`,
      },
    },
    type: "clipboard-encode-success",
  });
  expect(encoded.transfer).toHaveLength(1);
  const received = structuredClone(encoded.value, { transfer: [...encoded.transfer] });
  if (encoded.value.type !== "clipboard-encode-success-wire" || !encoded.value.result.ok) {
    throw new Error("Expected an encoded clipboard wire result.");
  }
  expect(encoded.value.result.value.canonicalText.byteLength).toBe(0);
  const slices = measuredCheckpoint({ betweenSlices: yieldToMainThread });
  const started = performance.now();
  const adopted = await decodeRuntimeResultChunked(received, {
    checkpoint: slices.checkpoint,
    signal: new AbortController().signal,
  });
  slices.finish();
  const totalMs = performance.now() - started;
  expect(adopted).toMatchObject({
    result: { ok: true, value: { customText } },
    type: "clipboard-encode-success",
  });
  return {
    activeMs: slices.durations.reduce((total, duration) => total + duration, 0),
    maximumSliceMs: summarizeDurations(slices.durations).maximum,
    totalMs,
  };
}

function measuredCheckpoint(options: { readonly betweenSlices?: () => Promise<void> } = {}): {
  readonly checkpoint: () => Promise<void>;
  readonly durations: number[];
  readonly finish: () => void;
} {
  const durations: number[] = [];
  let sliceStarted = performance.now();
  const capture = (): void => {
    durations.push(performance.now() - sliceStarted);
    sliceStarted = performance.now();
  };
  return {
    checkpoint: async () => {
      capture();
      if (options.betweenSlices !== undefined) {
        await options.betweenSlices();
        sliceStarted = performance.now();
      }
    },
    durations,
    finish: capture,
  };
}

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
          expect(calls).toHaveLength(1);
          expect(calls[0]!.bytes).toBeLessThanOrEqual(WORK_CHUNK_BYTES);
          if (totalBytes < output.byteLength) expect(calls[0]!.stream).toBe(true);
          else expect(calls[0]!.stream).not.toBe(true);
          calls.length = 0;
          checkpoints += 1;
        },
      });
      expect(adopted).toBe(expected);
      expect(totalBytes).toBe(FULL_OUTPUT_BYTES);
      expect(flushes).toBe(1);
      expect(checkpoints).toBe(Math.ceil(output.byteLength / WORK_CHUNK_BYTES) + 1);
      expect(calls).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    { elements: 129, points: 1 },
    { elements: 7, points: 4096 },
  ])(
    "bounds observed packing work for $elements strokes of $points points",
    async ({ elements, points }) => {
      const observed = observedPackingInput(elements, points);
      const slices: { elements: number; bytes: number; pointReads: number }[] = [];
      const checkpoint = async (): Promise<void> => {
        const slice = observed.capture();
        slices.push(slice);
        expect(slice.elements).toBeLessThanOrEqual(64);
        expect(slice.bytes - points * 3 * Float64Array.BYTES_PER_ELEMENT).toBeLessThan(
          WORK_CHUNK_BYTES,
        );
        expect(slice.pointReads).toBeGreaterThanOrEqual(slice.elements * points * 3);
        expect(slice.pointReads).toBeLessThanOrEqual(slice.elements * points * 8);
      };
      const packed = await packElementsChunked(observed.elements, {
        checkpoint,
        signal: new AbortController().signal,
      });
      expect(slices).toHaveLength(2);
      await checkpoint();
      expect(slices.reduce((sum, slice) => sum + slice.elements, 0)).toBe(elements);
      expect(slices.reduce((sum, slice) => sum + slice.bytes, 0)).toBe(elements * points * 24);
      expect(packed.records).toHaveLength(elements);
      expect(packed.pointBuffers).toHaveLength(elements);
      for (const [index, buffer] of packed.pointBuffers.entries()) {
        expect(packed.records[index]).toMatchObject({
          id: `stroke-${index}`,
          pointsBufferIndex: index,
        });
        expect(Array.from(buffer)).toEqual(observed.samples);
      }
    },
  );
});

function observedPackingInput(elementCount: number, pointCount: number) {
  const samples = Array.from({ length: pointCount * 3 }, (_, index) => (index % 3 === 2 ? 1 : 0));
  let pointReads = 0;
  let elementReads = 0;
  let nextIndex = 0;
  const points = new Proxy(samples, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) pointReads += 1;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
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
      const result = { elements: elementReads, bytes: elementReads * pointCount * 24, pointReads };
      elementReads = 0;
      pointReads = 0;
      return result;
    },
  };
}
