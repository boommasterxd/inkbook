import { expect, it, vi } from "vitest";

import { createTestWorkScheduler } from "../../../../fixtures/persistence/work-scheduler";
import {
  DocumentWorkerRuntime,
  GestureAwareSliceScheduler,
} from "../../../../../src/persistence/worker/runtime/public";
import { executor, rectangleDocument } from "./fixtures";

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
