import { describe, expect, it, vi } from "vitest";
import * as geometry from "../../../src/domain/geometry/public";
import { IncrementalDocumentSerializer } from "../../../src/persistence/serialization/public";
import { DocumentModelRuntime } from "../../../src/persistence/worker/runtime/document-model";
import { createStandardPersistenceFixture } from "./fixtures";
import { observeSchemaArray } from "../../fixtures/domain/schema-array-work";
import { ElementStore } from "../../../src/domain/store/public";
import { prepareInsertionElementSteps } from "../../../src/domain/store/prepared-insertion-element";
import { completeSerializationSteps } from "../../../src/persistence/serialization/serialization-model-preparation";
import * as boundsSteps from "../../../src/domain/geometry/bounds";
import * as schema from "../../../src/domain/schema/element-validation";
import { maximumLengthHighlighter } from "../../unit/domain/store/fixtures";

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
