import { expect, it, vi } from "vitest";

import { createTestWorkScheduler } from "../../../../fixtures/persistence/work-scheduler";
import { IncrementalDocumentSerializer } from "../../../../../src/persistence/serialization/incremental-document-serializer";
import { ElementFragmentCache } from "../../../../../src/persistence/serialization/element-fragment-cache";
import { DocumentModelRuntime } from "../../../../../src/persistence/worker/runtime/document-model";
import {
  DocumentWorkerRuntime,
  GestureAwareSliceScheduler,
} from "../../../../../src/persistence/worker/runtime/public";
import { executor, rectangle, rectangleDocument } from "./fixtures";

it("admits background prewarming through the input gate without a forced frame wait", async () => {
  let releaseCheckpoint = (): void => undefined;
  let holdCheckpoint = false;
  const nextFrame = vi.fn(async () => undefined);
  const scheduler = new GestureAwareSliceScheduler({
    isInputActive: () => false,
    workScheduler: createTestWorkScheduler({
      checkpoint: () =>
        holdCheckpoint
          ? new Promise<void>((resolve) => {
              releaseCheckpoint = resolve;
            })
          : undefined,
      nextFrame,
    }),
  });
  const runtime = new DocumentWorkerRuntime(executor, scheduler);
  await runtime.execute({
    baseModelRevision: null,
    identity: { ...executor, operationId: 1, purpose: "clipboard" },
    modelRevision: 0,
    snapshot: rectangleDocument(3),
    type: "model-sync-full",
  });

  runtime.setLiveInputActive(true);
  runtime.requestPrewarm();
  expect(runtime.instrumentation.prewarmVisitedElements).toBe(0);
  holdCheckpoint = true;
  runtime.setLiveInputActive(false);
  await Promise.resolve();
  expect(runtime.instrumentation.prewarmVisitedElements).toBe(0);
  expect(nextFrame).not.toHaveBeenCalled();

  holdCheckpoint = false;
  releaseCheckpoint();
  await vi.waitFor(() => expect(runtime.instrumentation.prewarmVisitedElements).toBe(3));
  expect(runtime.instrumentation.prewarmedElements).toBe(3);
  runtime.terminate();
  expect(runtime.instrumentation.prewarmedElements).toBe(0);
});

it("skips a complete export cache and resumes prewarming after model synchronization", async () => {
  const model = new DocumentModelRuntime();
  const snapshot = rectangleDocument(3);
  const prewarm = vi.spyOn(IncrementalDocumentSerializer.prototype, "prewarmElementAt");
  const checkpoint = vi.fn(() => undefined);
  const context = { checkpoint, signal: new AbortController().signal };
  try {
    const result = await model.export({
      ...executor,
      baseModelRevision: null,
      exportGeneration: 1,
      modelRevision: 0,
      snapshot,
      type: "export-full",
    });
    expect(result.ok).toBe(true);
    expect(await model.prewarmOne(context)).toBe(false);
    expect(prewarm).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalled();
    model.synchronize({
      ...executor,
      baseModelRevision: 0,
      changedElements: [rectangle(180)],
      identity: { ...executor, operationId: 2, purpose: "clipboard" },
      modelRevision: 1,
      type: "model-sync-incremental",
    });
    expect(await model.prewarmOne(context)).toBe(true);
    expect(prewarm).toHaveBeenCalledOnce();
    expect(checkpoint).toHaveBeenCalledOnce();
  } finally {
    prewarm.mockRestore();
    model.clear();
  }
});

it("prewarms a fragment whose cache admission was refused during export", async () => {
  const model = new DocumentModelRuntime();
  const admission = vi.spyOn(ElementFragmentCache.prototype, "retainIfSpace");
  admission.mockImplementationOnce(() => undefined);
  try {
    const result = await model.export({
      ...executor,
      baseModelRevision: null,
      exportGeneration: 1,
      modelRevision: 0,
      snapshot: rectangleDocument(3),
      type: "export-full",
    });
    expect(result.ok).toBe(true);
    expect(model.instrumentation.cacheElements).toBe(2);
    expect(
      await model.prewarmOne({
        checkpoint: () => undefined,
        signal: new AbortController().signal,
      }),
    ).toBe(true);
    expect(model.instrumentation).toMatchObject({
      cacheElements: 3,
      fragmentBuilds: 4,
      prewarmedElements: 1,
      prewarmVisitedElements: 1,
    });
  } finally {
    admission.mockRestore();
    model.clear();
  }
});

it.each(["cancelled", "failed"] as const)(
  "preserves prewarming after a %s export",
  async (mode) => {
    const model = new DocumentModelRuntime();
    model.initialize(rectangleDocument(3));
    const controller = new AbortController();
    let checkpoints = 0;
    try {
      const result = await model.export(
        {
          ...executor,
          baseModelRevision: 0,
          exportGeneration: 1,
          modelRevision: 0,
          ...(mode === "failed" ? { orderChanges: { content: [] } } : {}),
          type: "export-incremental",
        },
        {
          checkpoint: () => {
            checkpoints += 1;
            if (checkpoints === 3) controller.abort();
            return undefined;
          },
          signal: controller.signal,
        },
      );
      expect(result.ok).toBe(false);
      expect(model.instrumentation.cacheElements).toBe(mode === "cancelled" ? 3 : 0);
      const checkpoint = vi.fn(() => undefined);
      expect(await model.prewarmOne({ checkpoint, signal: new AbortController().signal })).toBe(
        true,
      );
      expect(checkpoint).toHaveBeenCalledOnce();
      expect(model.instrumentation.prewarmVisitedElements).toBe(1);
    } finally {
      model.clear();
    }
  },
);
