import { describe, expect, it, vi } from "vitest";
import * as geometry from "../../../src/domain/geometry/public";
import { IncrementalDocumentSerializer } from "../../../src/persistence/serialization/public";
import { DocumentModelRuntime } from "../../../src/persistence/worker/runtime/document-model";
import { createStandardPersistenceFixture } from "./fixtures";

describe("validated model paste work", () => {
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
