import { describe, expect, it } from "vitest";

import { INKBOOK_CLIPBOARD_TEXT_PREFIX } from "../../../src/persistence/clipboard/constants";
import { yieldToMainThread } from "../../../src/persistence/scheduling/main-thread-yield";
import { adoptUtf8Output } from "../../../src/persistence/scheduling/utf8-adoption";
import {
  encodeRuntimeRequestChunked,
  encodeRuntimeResult,
} from "../../../src/persistence/worker/runtime/public";
import { decodeRuntimeResultChunked } from "../../../src/persistence/worker/runtime/wire-codec";
import { EXPORT_OUTPUT_WIRE_FORMAT } from "../../../src/persistence/worker/runtime/export-output-wire";
import { createStandardPersistenceFixture, STANDARD_STROKES } from "./fixtures";
import {
  annotateDurations,
  collectProfileGarbage,
  expectProfileBudget,
  summarizeDurations,
} from "./metrics";

const AUTOSAVE_MAIN_THREAD_BUDGET_MS = 8;
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
  }, 120_000);

  it("adopts a maximum-size UTF-8 result in bounded main-thread slices", async ({ annotate }) => {
    const output = new Uint8Array(FULL_OUTPUT_BYTES);
    output.fill(97);
    await measureUtf8Adoption(output);
    const measurements: SliceMeasurement[] = [];
    for (let run = 0; run < 5; run += 1) measurements.push(await measureUtf8Adoption(output));

    const sliceDurations = measurements.map(({ maximumSliceMs }) => maximumSliceMs);
    await annotateDurations(annotate, "UTF-8 result adoption slices", sliceDurations);
    await annotateDurations(
      annotate,
      "UTF-8 result adoption total",
      measurements.map(({ totalMs }) => totalMs),
    );
    expectProfileBudget(sliceDurations, AUTOSAVE_MAIN_THREAD_BUDGET_MS);
  }, 120_000);

  for (const profile of ["desktop", "mobile"] as const) {
    it(`selects transferred UTF-8 from a deterministic ${profile} wire comparison`, async ({
      annotate,
    }) => {
      const output = "a".repeat(WIRE_REFERENCE_BYTES);
      compareWireFormats(output);
      const cloned: number[] = [];
      const transferred: number[] = [];
      for (let run = 0; run < 5; run += 1) {
        const measurement = compareWireFormats(output);
        cloned.push(measurement.clonedStringMs);
        transferred.push(measurement.transferredUtf8Ms);
      }

      await annotateDurations(annotate, `${profile} cloned string wire`, cloned);
      await annotateDurations(annotate, `${profile} transferred UTF-8 wire`, transferred);
      expect(EXPORT_OUTPUT_WIRE_FORMAT).toBe("transferred-utf8");
      expect(summarizeDurations(transferred).p50).toBeLessThan(summarizeDurations(cloned).p50);
    }, 120_000);
  }

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
  }, 120_000);
});

interface SliceMeasurement {
  readonly maximumSliceMs: number;
  readonly totalMs: number;
  readonly transferredBytes?: number;
}

function compareWireFormats(output: string): {
  readonly clonedStringMs: number;
  readonly transferredUtf8Ms: number;
} {
  let started = performance.now();
  const cloned = structuredClone(output);
  const clonedStringMs = performance.now() - started;
  expect(cloned.length).toBe(output.length);

  started = performance.now();
  const encoded = new TextEncoder().encode(output);
  const transferred = structuredClone(encoded, { transfer: [encoded.buffer] });
  const adopted = new TextDecoder("utf-8", { fatal: true }).decode(transferred);
  const transferredUtf8Ms = performance.now() - started;
  expect(encoded.byteLength).toBe(0);
  expect(adopted.length).toBe(output.length);
  return { clonedStringMs, transferredUtf8Ms };
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
  expect(encoded.value.type).toBe("export-full-wire");
  expect(encoded.transfer).toHaveLength(STANDARD_STROKES);
  return {
    maximumSliceMs: summarizeDurations(slices.durations).maximum,
    totalMs: performance.now() - started,
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
  expect(adopted.length).toBe(output.byteLength);
  expect(adopted.charCodeAt(0)).toBe(97);
  expect(adopted.charCodeAt(adopted.length - 1)).toBe(97);
  return {
    maximumSliceMs: summarizeDurations(slices.durations).maximum,
    totalMs: performance.now() - started,
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
  expect(adopted).toMatchObject({
    result: { ok: true, value: { customText } },
    type: "clipboard-encode-success",
  });
  return {
    maximumSliceMs: summarizeDurations(slices.durations).maximum,
    totalMs: performance.now() - started,
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
