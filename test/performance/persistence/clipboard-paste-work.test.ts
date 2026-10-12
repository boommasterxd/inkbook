import { describe, expect, it, vi } from "vitest";
import * as geometry from "../../../src/domain/geometry/public";
import { IncrementalDocumentSerializer } from "../../../src/persistence/serialization/public";
import { DocumentModelRuntime } from "../../../src/persistence/worker/runtime/document-model";
import { createClipboardLimitFixture, createStandardPersistenceFixture } from "./fixtures";
import { observeSchemaArray } from "../../fixtures/domain/schema-array-work";
import { ElementStore } from "../../../src/domain/store/public";
import { prepareInsertionElementSteps } from "../../../src/domain/store/prepared-insertion-element";
import { completeSerializationSteps } from "../../../src/persistence/serialization/serialization-model-preparation";
import * as boundsSteps from "../../../src/domain/geometry/bounds";
import * as schema from "../../../src/domain/schema/element-validation";
import { maximumLengthHighlighter } from "../../unit/domain/store/fixtures";
import * as sampleCopy from "../../../src/domain/elements/runtime-sample-copy";
import * as sampleValidation from "../../../src/domain/schema/stroke-sample-range-validation";
import * as runtimeElements from "../../../src/persistence/worker/runtime/runtime-elements";
import {
  decodeRuntimeResultChunked,
  encodeRuntimeResult,
} from "../../../src/persistence/worker/runtime/wire-codec";
import { ClipboardAdoptionGuard } from "../../../src/obsidian/embeds/active-editor/clipboard-adoption-guard";
import * as elementCopy from "../../../src/domain/elements/runtime-element-copy";

it("captures maximum clipboard wire samples once and reuses preparation through Store adoption", async () => {
  const elements = createClipboardLimitFixture();
  const ids = elements.map(({ id }) => id);
  const encoded = encodeRuntimeResult({
    identity: { operationId: 1, purpose: "clipboard", sessionId: "paste-work", workerEpoch: 1 },
    type: "clipboard-plan-paste-success",
    result: {
      ok: true,
      value: {
        activateTool: "select",
        commandTimestamp: 1,
        contentIds: ids,
        elements,
        highlightIds: [],
        insertAtBandFront: true,
        repeatState: { fingerprint: "capacity", pasteCount: 1 },
        selectedIds: ids,
        translation: { x: 0, y: 0 },
      },
    },
  });
  const wire = structuredClone(encoded.value, { transfer: [...encoded.transfer] });
  const copy = vi.spyOn(sampleCopy, "copySampleRange");
  const validation = vi.spyOn(sampleValidation, "assertStrokeSampleRange");
  const wireValidation = vi.spyOn(runtimeElements, "validateRuntimeSamplesSteps");
  const descriptors = vi.spyOn(Object, "getOwnPropertyDescriptor");
  const headers = vi.spyOn(elementCopy, "captureRuntimeElementHeader");
  const capturedHeaders = vi.spyOn(elementCopy, "captureImmutableRuntimeElementHeader");
  const store = new ElementStore();
  const guard = new ClipboardAdoptionGuard(store);
  try {
    const decoded = await decodeRuntimeResultChunked(wire, {
      checkpoint: () => undefined,
      signal: new AbortController().signal,
    });
    if (decoded.type !== "clipboard-plan-paste-success" || !decoded.result.ok)
      throw new Error("Expected a prepared paste plan.");
    expect(copy).toHaveBeenCalledTimes(4_000);
    expect(copy.mock.calls.reduce((total, [, , start, end]) => total + end - start, 0)).toBe(
      1_500_000,
    );
    expect(validation).toHaveBeenCalledTimes(4_000);
    expect(wireValidation).not.toHaveBeenCalled();
    // Each wire header is captured inside its producer; insertion adds no second deep copy.
    expect(headers).not.toHaveBeenCalled();
    expect(capturedHeaders).toHaveBeenCalledTimes(5_000);
    const stagedSamples = new Set(
      decoded.result.value.elements.flatMap((element) =>
        element.kind === "stroke" ? [element.points] : [],
      ),
    );
    expect(
      descriptors.mock.calls.filter(
        ([value, key]) =>
          stagedSamples.has(value as number[]) && /^(0|[1-9][0-9]*)$/.test(String(key)),
      ),
    ).toHaveLength(0);
    descriptors.mockRestore();
    headers.mockRestore();
    capturedHeaders.mockRestore();
    const prepared = await guard.prepare(decoded.result.value, {
      shouldYield: () => false,
      yieldControl: async () => undefined,
    });
    if (prepared === null) throw new Error("Expected accepted clipboard capacity.");
    const insertion = await store.prepareElementAppend(prepared.elements, {
      shouldYield: () => false,
      yieldControl: async () => undefined,
    });
    if (insertion.token === null) throw new Error("Expected prepared insertion.");
    expect(store.commitPreparedElementMutation(insertion.token).status).toBe("committed");
    expect(store.size).toBe(5_000);
    // Public history remains mutable and owns one independent copy per inserted stroke.
    expect(copy).toHaveBeenCalledTimes(8_000);
    expect(validation).toHaveBeenCalledTimes(4_000);
  } finally {
    guard.dispose();
    copy.mockRestore();
    validation.mockRestore();
    wireValidation.mockRestore();
    descriptors.mockRestore();
    headers.mockRestore();
    capturedHeaders.mockRestore();
  }
});

describe("validated model paste work", () => {
  it("copies one selected stroke in a 10,000-stroke document with bounded record lookups", () => {
    const snapshot = createStandardPersistenceFixture();
    const model = new DocumentModelRuntime();
    model.initialize(snapshot);
    const selected = snapshot.elements.find((element) => element.kind === "stroke")!;
    const reads = vi.spyOn(Map.prototype, "get");
    const snapshots = vi.spyOn(IncrementalDocumentSerializer.prototype, "currentSnapshot");
    try {
      expect(model.encodeClipboard(snapshot.revision, [selected.id]).ok).toBe(true);
      expect(reads.mock.calls.length).toBeLessThanOrEqual(8);
      expect(snapshots).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
      snapshots.mockRestore();
    }
  });

  it("reads each external sample once and reuses validated bounds across Store adoption", async () => {
    const source = maximumLengthHighlighter();
    const samples = observeSchemaArray(source.points);
    source.points = samples.observed;
    const staged = completeSerializationSteps(prepareInsertionElementSteps(source));
    expect(samples.work.indexedReads).toBe(source.points.length);
    expect(samples.work.descriptorReads).toBeLessThanOrEqual(3 * source.points.length);
    const geometry = vi.spyOn(boundsSteps, "calculateElementBoundsSteps");
    const validation = vi.spyOn(schema, "validateInkElementV1Steps");
    try {
      const store = new ElementStore();
      const prepared = await store.prepareElementAppend([staged], {
        shouldYield: () => false,
        yieldControl: async () => undefined,
      });
      expect(prepared.status).toBe("prepared");
      if (prepared.token === null) throw new Error("Expected prepared insertion.");
      store.commitPreparedElementMutation(prepared.token);
      expect(store.size).toBe(1);
      expect(geometry).not.toHaveBeenCalled();
      expect(validation).not.toHaveBeenCalled();
      expect(samples.work.indexedReads).toBe(source.points.length);
      expect(samples.work.descriptorReads).toBeLessThanOrEqual(3 * source.points.length);
    } finally {
      geometry.mockRestore();
      validation.mockRestore();
    }
  });
  it("plans a small paste into 10,000 strokes without rescanning existing geometry", () => {
    const snapshot = createStandardPersistenceFixture();
    const model = new DocumentModelRuntime();
    model.initialize(snapshot);
    const selected = snapshot.elements.find((element) => element.kind === "stroke");
    if (selected === undefined) throw new Error("The fixture has no stroke.");
    const encoded = model.encodeClipboard(snapshot.revision, [selected.id]);
    if (!encoded.ok) throw new Error(encoded.error.message);

    const bounds = vi.spyOn(geometry, "calculateElementBounds");
    const snapshots = vi.spyOn(IncrementalDocumentSerializer.prototype, "currentSnapshot");
    const plan = model.planClipboardPaste(
      snapshot.revision,
      { customText: encoded.value.customText },
      { kind: "toolbar", visibleCanvasCenter: { x: 300, y: 300 } },
      10_000,
      () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );

    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.value.elements).toHaveLength(1);
    expect(bounds.mock.calls.length).toBeLessThanOrEqual(2);
    expect(snapshots).toHaveBeenCalledTimes(0);
    expect(model.instrumentation.fullValidationRuns).toBe(1);
    bounds.mockRestore();
    snapshots.mockRestore();
  });
});
