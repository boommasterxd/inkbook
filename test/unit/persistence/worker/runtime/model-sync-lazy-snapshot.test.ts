import { expect, it, vi } from "vitest";

import { IncrementalDocumentSerializer } from "../../../../../src/persistence/serialization/incremental-document-serializer";
import { DocumentModelRuntime } from "../../../../../src/persistence/worker/runtime/document-model";
import { executor, rectangle, snapshot } from "./fixtures";

function synchronizeOnce(model: DocumentModelRuntime): void {
  model.synchronize({
    baseModelRevision: 0,
    changedElements: [rectangle(180)],
    identity: { ...executor, operationId: 2, purpose: "clipboard" },
    modelRevision: 1,
    type: "model-sync-incremental",
  });
}

function synchronizedModel(): DocumentModelRuntime {
  const model = new DocumentModelRuntime();
  model.initialize(snapshot());
  synchronizeOnce(model);
  return model;
}

it("defers complete snapshot creation until clipboard needs it after sync", async () => {
  const model = new DocumentModelRuntime();
  model.initialize(snapshot());
  const materialize = vi.spyOn(IncrementalDocumentSerializer.prototype, "currentSnapshot");
  try {
    synchronizeOnce(model);
    expect(model.modelRevision).toBe(1);
    expect(
      await model.prewarmOne({
        checkpoint: async () => undefined,
        signal: new AbortController().signal,
      }),
    ).toBe(false);
    expect(materialize).not.toHaveBeenCalled();
    expect(model.encodeClipboard(1, [rectangle().id]).ok).toBe(true);
    expect(model.encodeClipboard(1, [rectangle().id]).ok).toBe(true);
    expect(materialize).toHaveBeenCalledTimes(1);
  } finally {
    materialize.mockRestore();
  }
});

it("keeps full-sync recovery available after a cancelled prewarm", async () => {
  const model = synchronizedModel();
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    model.prewarmOne({ checkpoint: async () => undefined, signal: cancelled.signal }),
  ).rejects.toThrow();
  expect(model.instrumentation.prewarmVisitedElements).toBe(0);

  model.synchronize({
    baseModelRevision: null,
    identity: { ...executor, operationId: 3, purpose: "clipboard" },
    modelRevision: 2,
    snapshot: snapshot(2, 220),
    type: "model-sync-full",
  });
  expect(model.modelRevision).toBe(2);
  expect(() => model.encodeClipboard(1, [rectangle().id])).toThrow("basis-revision-mismatch");
  expect(model.encodeClipboard(2, [rectangle().id]).ok).toBe(true);
});

it("builds one snapshot when exporting after lazy model sync", async () => {
  const model = synchronizedModel();
  const materialize = vi.spyOn(IncrementalDocumentSerializer.prototype, "currentSnapshot");
  try {
    const exported = await model.export({
      ...executor,
      baseModelRevision: 1,
      exportGeneration: 1,
      modelRevision: 1,
      type: "export-incremental",
    });
    expect(exported.ok).toBe(true);
    expect(materialize).toHaveBeenCalledTimes(1);
  } finally {
    materialize.mockRestore();
  }
});

it("rejects clipboard access after an unconfirmed export changes serializer state", async () => {
  const model = synchronizedModel();
  const cancelled = new AbortController();
  cancelled.abort();
  const failed = await model.export(
    {
      ...executor,
      baseModelRevision: 1,
      changedElements: [rectangle(220)],
      exportGeneration: 1,
      modelRevision: 2,
      type: "export-incremental",
    },
    { checkpoint: async () => undefined, signal: cancelled.signal },
  );
  expect(failed.ok).toBe(false);
  expect(model.modelRevision).toBe(1);
  for (const revision of [1, 2]) {
    expect(() => model.encodeClipboard(revision, [rectangle().id])).toThrow(
      "basis-revision-mismatch",
    );
  }

  model.synchronize({
    baseModelRevision: null,
    identity: { ...executor, operationId: 3, purpose: "clipboard" },
    modelRevision: 3,
    snapshot: snapshot(3, 240),
    type: "model-sync-full",
  });
  expect(model.encodeClipboard(3, [rectangle().id]).ok).toBe(true);
});
