import { expect, it } from "vitest";

import {
  decodeCustomClipboardText,
  encodeSelection,
  planPaste,
} from "../../../src/persistence/clipboard/public";
import { serializeInkbookDocument } from "../../../src/persistence/serialization/public";
import { DocumentWorkerRuntime } from "../../../src/persistence/worker/runtime/public";
import { CLIPBOARD_ELEMENTS, CLIPBOARD_POINTS, createClipboardLimitFixture } from "./fixtures";
import { createMinimalPersistenceFixture } from "./fixtures";
import {
  annotateProfileRuns,
  collectProfileGarbage,
  expectProfileRunsBudget,
  measure,
} from "./metrics";

const MIB = 1024 * 1024;
const CLIPBOARD_SAMPLES_PER_RUN = 20;
const MEASURED_RUNS = 5;

it("encodes and decodes the maximum deterministic clipboard fixture", async ({ annotate }) => {
  const elements = createClipboardLimitFixture();
  const selectedIds = new Set(elements.map(({ id }) => id));
  const warmupEncoded = encodeSelection(elements, selectedIds);
  if (!warmupEncoded.ok) throw new Error(warmupEncoded.error.message);
  const canonicalText = warmupEncoded.value.customText;
  const warmupDecoded = decodeCustomClipboardText(canonicalText);
  if (!warmupDecoded.ok) throw new Error(warmupDecoded.error.message);

  runClipboardProfile(elements, selectedIds, canonicalText);
  const encodeRuns: number[][] = [];
  const pasteRuns: number[][] = [];
  let byteLength = warmupEncoded.value.byteLength;
  for (let run = 0; run < MEASURED_RUNS; run += 1) {
    const profile = runClipboardProfile(elements, selectedIds, canonicalText);
    encodeRuns.push(profile.encode);
    pasteRuns.push(profile.paste);
    byteLength = profile.byteLength;
  }

  expect(byteLength).toBeLessThanOrEqual(8 * MIB);
  await annotateProfileRuns(annotate, "clipboard copy", encodeRuns);
  await annotateProfileRuns(annotate, "clipboard paste", pasteRuns);
  await annotate(
    `clipboard payload: total=${byteLength} bytes, ` +
      `bytesPerStrokePoint=${(byteLength / CLIPBOARD_POINTS).toFixed(3)}`,
    "performance",
  );
  expectProfileRunsBudget(encodeRuns, 750);
  expectProfileRunsBudget(pasteRuns, 750);
}, 300_000);

it("keeps the maximum worker Clipboard model coherent across delta, zero-delta, and stale work", async ({
  annotate,
}) => {
  const elements = createClipboardLimitFixture();
  const snapshot = { ...createMinimalPersistenceFixture(), elements: [...elements] };
  const serialized = serializeInkbookDocument(snapshot);
  if (!serialized.ok) throw new Error(serialized.error.message);
  const executor = { sessionId: "clipboard-performance", workerEpoch: 1 } as const;
  const runtime = new DocumentWorkerRuntime(executor);
  try {
    const unlocked = await runtime.execute({
      identity: { ...executor, operationId: 1, purpose: "unlock" },
      input: serialized.value.svg,
      type: "unlock",
    });
    expect(unlocked).toMatchObject({
      snapshot: { elementCount: CLIPBOARD_ELEMENTS, revision: 0 },
      type: "unlock-success",
    });

    const first = elements[0];
    if (first?.kind !== "stroke") throw new Error("Expected the first Clipboard stroke.");
    const changed = {
      ...first,
      style: { ...first.style, opacity: 0.75 },
    };
    const clipboardIdentity = {
      ...executor,
      operationId: 2,
      purpose: "clipboard" as const,
    };
    await expect(
      runtime.execute({
        baseModelRevision: 0,
        changedElements: [changed],
        identity: clipboardIdentity,
        modelRevision: 1,
        type: "model-sync-incremental",
      }),
    ).resolves.toMatchObject({ modelRevision: 1, type: "model-sync-success" });

    const encoded = await runtime.execute({
      basisRevision: 1,
      identity: { ...clipboardIdentity, operationId: 3 },
      selectedIds: elements.map(({ id }) => id),
      type: "clipboard-encode",
    });
    if (encoded.type !== "clipboard-encode-success" || !encoded.result.ok) {
      throw new Error("Maximum worker Clipboard encoding failed.");
    }
    expect(encoded.result.value.byteLength).toBeLessThanOrEqual(8 * MIB);
    const decoded = await runtime.execute({
      basisRevision: 1,
      candidates: { customText: encoded.result.value.customText },
      identity: { ...clipboardIdentity, operationId: 4 },
      type: "clipboard-decode",
    });
    expect(decoded).toMatchObject({ result: { ok: true }, type: "clipboard-decode-success" });
    if (decoded.type !== "clipboard-decode-success" || !decoded.result.ok) {
      throw new Error("Maximum worker Clipboard decoding failed.");
    }
    expect(decoded.result.value.payload.elements).toHaveLength(CLIPBOARD_ELEMENTS);

    const stale = await runtime.execute({
      baseModelRevision: 0,
      changedElements: [changed],
      identity: { ...clipboardIdentity, operationId: 5 },
      modelRevision: 2,
      type: "model-sync-incremental",
    });
    expect(stale).toMatchObject({ code: "base-revision-mismatch", type: "runtime-failure" });
    const zeroDelta = await runtime.execute({
      ...executor,
      baseModelRevision: 1,
      exportGeneration: 1,
      modelRevision: 1,
      type: "export-incremental",
    });
    expect(zeroDelta).toMatchObject({ modelRevision: 1, type: "export-success" });
    await annotate(
      `maximum worker Clipboard flow: elements=${CLIPBOARD_ELEMENTS}, ` +
        `points=${CLIPBOARD_POINTS}, deltaRevision=1, staleRejected=true, zeroDeltaExport=true`,
      "performance",
    );
  } finally {
    runtime.terminate();
  }
}, 120_000);

function runClipboardProfile(
  elements: ReturnType<typeof createClipboardLimitFixture>,
  selectedIds: ReadonlySet<string>,
  canonicalText: string,
): { byteLength: number; encode: number[]; paste: number[] } {
  const encode: number[] = [];
  let byteLength = 0;
  for (let sample = 0; sample < CLIPBOARD_SAMPLES_PER_RUN; sample += 1) {
    const encoded = measure(() => encodeSelection(elements, selectedIds));
    if (!encoded.value.ok) throw new Error(encoded.value.error.message);
    expect(encoded.value.value.payload.elements).toHaveLength(CLIPBOARD_ELEMENTS);
    expect(encoded.value.value.customText).toBe(canonicalText);
    byteLength = encoded.value.value.byteLength;
    encode.push(encoded.durationMs);
    collectProfileGarbage();
  }

  const paste: number[] = [];
  for (let sample = 0; sample < CLIPBOARD_SAMPLES_PER_RUN; sample += 1) {
    const planned = measure(() => decodeAndPlanPaste(canonicalText, sample));
    expect(planned.value.elements).toHaveLength(CLIPBOARD_ELEMENTS);
    paste.push(planned.durationMs);
    collectProfileGarbage();
  }
  return { byteLength, encode, paste };
}

function decodeAndPlanPaste(canonicalText: string, sample: number) {
  const decoded = decodeCustomClipboardText(canonicalText);
  if (!decoded.ok) throw new Error(decoded.error.message);
  let nextId = 0;
  const planned = planPaste({
    commandTimestamp: sample,
    createId: () => uuid(nextId++),
    decoded: decoded.value,
    existingElements: [],
    page: createMinimalPersistenceFixture().page,
    target: { x: 1024, y: 512 },
  });
  if (!planned.ok) throw new Error(planned.error.message);
  return planned.value;
}

function uuid(value: number): string {
  return `10000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}
