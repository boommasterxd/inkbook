import { createHook } from "node:async_hooks";

import { expect, it, vi } from "vitest";
import * as sampleValidation from "../../../../src/domain/schema/stroke-sample-range-validation";
import * as geometry from "../../../../src/domain/geometry/bounds";

import {
  decodeCustomClipboardText,
  encodeRuntimeSelection,
} from "../../../../src/persistence/clipboard/codec";
import { planPaste } from "../../../../src/persistence/clipboard/operations";
import { validateClipboardPayloadSliced } from "../../../../src/persistence/clipboard/validation";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { DocumentWorkerRuntime } from "../../../../src/persistence/worker/runtime/public";
import { encodeRuntimeSelectionChunked } from "../../../../src/persistence/worker/runtime/model/fallback-clipboard-codec";
import { DocumentModelRuntime } from "../../../../src/persistence/worker/runtime/model/document-model";
import { ChunkedSha256 } from "../../../../src/persistence/serialization/chunked-output-sha256";
import { snapshot, stroke } from "../../../unit/domain/schema/fixtures";
import { validImageFixture } from "../../../fixtures/persistence/images";
import { textElement, validFontResource } from "../../../unit/persistence/clipboard/fixtures";
import { CLIPBOARD_ELEMENTS, CLIPBOARD_POINTS, createClipboardLimitFixture } from "../fixtures";
import { createMinimalPersistenceFixture } from "../fixtures";
import { observeSchemaArray } from "../../../fixtures/domain/schema-array-work";

const MIB = 1024 * 1024;
it("reuses verified model resources on Copy and checks their bytes again on Paste", async () => {
  const { asset, element: image } = await validImageFixture();
  const font = await validFontResource();
  const text = textElement();
  const model = new DocumentModelRuntime();
  const context = { checkpoint: () => undefined, signal: new AbortController().signal };
  model.initialize({
    ...snapshot([image, text]),
    version: 5,
    imageResources: [asset],
    fontResources: [font],
  });
  const hashed = vi.spyOn(ChunkedSha256.prototype, "update");
  try {
    const encoded = await model.encodeClipboardSliced(0, [image.id, text.id], context);
    if (!encoded.ok) throw new Error(encoded.error.message);
    expect(hashed).not.toHaveBeenCalled();
    const decoded = await model.decodeClipboardSliced(
      0,
      { plainText: encoded.value.plainText },
      context,
    );
    expect(decoded.ok).toBe(true);
    expect(hashed.mock.calls.reduce((sum, [bytes]) => sum + bytes.byteLength, 0)).toBe(
      atob(font.data).length + atob(asset.data).length,
    );
  } finally {
    hashed.mockRestore();
    model.clear();
  }
});

it("bounds postparse clipboard sample reads and discards cancelled validation", async () => {
  const observations = Array.from({ length: 1_000 }, (_, index) => {
    const element = stroke(index + 1);
    const observed = observeSchemaArray([...element.points]);
    const { createdAt: _createdAt, id: _id, ...body } = element;
    return { body: { ...body, points: observed.observed }, observed };
  });
  const payload = {
    elements: observations.map(({ body }, index) => ({
      clipId: index.toString(36),
      element: body,
    })),
    format: "inkbook-elements",
    version: 1,
  };
  const totalReads = () =>
    observations.reduce(
      (sum, { observed }) => sum + observed.work.indexedReads + observed.work.descriptorReads,
      0,
    );
  const controller = new AbortController();
  let checkpoints = 0;
  await expect(
    validateClipboardPayloadSliced(
      payload,
      async () => {
        checkpoints += 1;
        if (checkpoints === 3) controller.abort();
        controller.signal.throwIfAborted();
      },
      64,
      170,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(totalReads()).toBeLessThan(6_000);

  const readsPerCheckpoint: number[] = [];
  let lastReads = totalReads();
  const result = await validateClipboardPayloadSliced(
    payload,
    async () => {
      const reads = totalReads();
      readsPerCheckpoint.push(reads - lastReads);
      lastReads = reads;
    },
    64,
    170,
  );
  expect(result.ok).toBe(true);
  expect(readsPerCheckpoint.length).toBeGreaterThan(20);
  expect(readsPerCheckpoint.every((reads) => reads <= 6_000)).toBe(true);
});

it("bounds Promise allocation in the 1,000-stroke sliced clipboard fallback", async () => {
  const elements = Array.from({ length: 1_000 }, (_, index) => stroke(index + 1));
  const stringify = JSON.stringify;
  let numericWrites = 0;
  const json = vi.spyOn(JSON, "stringify").mockImplementation((value) => {
    if (typeof value === "number") numericWrites++;
    return stringify(value);
  });
  let checkpoints = 0;
  let promises = 0;
  const hook = createHook({
    init: (_id, type) => {
      if (type === "PROMISE") promises += 1;
    },
  });
  hook.enable();
  let encoded: Awaited<ReturnType<typeof encodeRuntimeSelectionChunked>>;
  try {
    encoded = await encodeRuntimeSelectionChunked(elements, {
      checkpoint: async () => {
        checkpoints += 1;
      },
      signal: new AbortController().signal,
      workProfile: { inputByteLimit: 16_384, nodeLimit: 256, outputByteLimit: 65_536 },
    });
  } finally {
    hook.disable();
    json.mockRestore();
  }
  expect(encoded.ok).toBe(true);
  // Each stroke writes six sample scalars, six geometry/style scalars, and one shared version.
  expect(numericWrites).toBe(12_001);
  expect(checkpoints).toBeGreaterThanOrEqual(102);
  expect(checkpoints).toBeLessThanOrEqual(125);
  // Checkpoints create Promises; the margin covers fixed test and serializer overhead.
  expect(promises).toBeLessThanOrEqual(300);
});

it("bounds clipboard work and payloads at the maximum fixture capacity", () => {
  const elements = createClipboardLimitFixture();
  const selectedIds = new Set(elements.map(({ id }) => id));
  const encoded = encodeObservedClipboard(elements, selectedIds);
  if (!encoded.ok) throw new Error(encoded.error.message);
  expect(encoded.value.payload.elements).toHaveLength(CLIPBOARD_ELEMENTS);
  expect(encoded.value.byteLength).toBeLessThanOrEqual(8 * MIB);
  const planned = decodeAndPlanPaste(encoded.value.customText, 0);
  expect(planned.elements).toHaveLength(CLIPBOARD_ELEMENTS);
  expect(new Set(planned.elements.map(({ id }) => id)).size).toBe(CLIPBOARD_ELEMENTS);
  expect(planned.elements.every(({ id }) => !selectedIds.has(id))).toBe(true);
  expect(
    planned.elements.reduce(
      (count, element) => count + (element.kind === "stroke" ? element.points.length / 3 : 0),
      0,
    ),
  ).toBe(CLIPBOARD_POINTS);
}, 120_000);

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

    const encoded = await observeClipboardEncode(() =>
      runtime.execute({
        basisRevision: 1,
        identity: { ...clipboardIdentity, operationId: 3 },
        selectedIds: elements.map(({ id }) => id),
        type: "clipboard-encode",
      }),
    );
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

async function observeClipboardEncode<T>(encode: () => Promise<T>): Promise<T> {
  const samples = vi.spyOn(sampleValidation, "assertStrokeSampleRange");
  const bounds = vi.spyOn(geometry, "calculateElementBoundsSteps");
  try {
    const result = await encode();
    expect(samples).not.toHaveBeenCalled();
    expect(bounds.mock.calls.some(([element]) => element.kind === "stroke")).toBe(false);
    return result;
  } finally {
    samples.mockRestore();
    bounds.mockRestore();
  }
}

function encodeObservedClipboard(
  elements: ReturnType<typeof createClipboardLimitFixture>,
  selectedIds: ReadonlySet<string>,
): ReturnType<typeof encodeRuntimeSelection> {
  let scalarReads = 0;
  const observed = elements.map((element) => {
    if (element.kind !== "stroke") return element;
    const points = new Proxy(element.points, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/u.test(property)) scalarReads += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    return { ...element, points };
  });
  const result = encodeRuntimeSelection(observed, selectedIds);
  expect(scalarReads).toBeGreaterThanOrEqual(CLIPBOARD_POINTS * 3);
  expect(scalarReads).toBeLessThanOrEqual(CLIPBOARD_POINTS * 3 * 12);
  return result;
}
