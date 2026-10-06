import { expect, it, vi } from "vitest";

import { createTestWorkScheduler } from "../../../../fixtures/persistence/work-scheduler";
import {
  DocumentWorkerRuntime,
  GestureAwareSliceScheduler,
} from "../../../../../src/persistence/worker/runtime/public";
import { executor, snapshot } from "./fixtures";

it.each([false, true])(
  "keeps queued fallback work outside navigation frame admission with reserve=%s",
  async (navigationReserve) => {
    const workScheduler = createTestWorkScheduler({ shouldYield: () => true });
    const nextFrame = vi.spyOn(workScheduler, "nextFrame");
    const runtime = new DocumentWorkerRuntime(
      executor,
      new GestureAwareSliceScheduler({
        isInputActive: () => false,
        workScheduler,
      }),
    );
    const document = snapshot();
    runtime.setNavigationActive(true);
    const exportPending = runtime.execute({
      ...executor,
      baseModelRevision: null,
      exportGeneration: 1,
      modelRevision: 0,
      snapshot: document,
      type: "export-full",
    });
    const identity = { ...executor, operationId: 1, purpose: "background" as const };
    await runtime.execute({
      baseModelRevision: null,
      identity,
      modelRevision: 0,
      snapshot: document,
      type: "model-sync-full",
    });
    runtime.setLiveInputActive(true);
    const paths = runtime.execute({
      basisRevision: 0,
      identity,
      ids: document.elements.map((element) => element.id),
      ...(navigationReserve ? { speculative: true, navigationReserve: true } : {}),
      type: "prepare-scene-paths",
    });
    await Promise.resolve();
    expect(runtime.instrumentation.shapeBuilds).toBe(0);
    runtime.setLiveInputActive(false);
    expect((await paths).type).toBe("prepare-scene-paths-success");
    expect(nextFrame).toHaveBeenCalledWith(expect.any(AbortSignal), "frame");
    expect(runtime.instrumentation.fragmentBuilds).toBe(0);
    runtime.setNavigationActive(false);
    expect((await exportPending).type).toBe("export-success");
    runtime.terminate();
  },
);

it("pauses fallback work while a live gesture is active", async () => {
  let active = true;
  let yields = 0;
  const scheduler = new GestureAwareSliceScheduler({
    isInputActive: () => active,
    workScheduler: createTestWorkScheduler({
      checkpoint: async () => {
        yields += 1;
      },
    }),
  });
  const runtime = new DocumentWorkerRuntime(executor, scheduler);
  let settled = false;
  const pending = runtime
    .execute({
      ...executor,
      baseModelRevision: null,
      exportGeneration: 1,
      modelRevision: 0,
      snapshot: snapshot(),
      type: "export-full",
    })
    .finally(() => {
      settled = true;
    });

  await Promise.resolve();
  expect(settled).toBe(false);
  active = false;
  scheduler.setLiveInputActive(false);
  const result = await pending;

  expect(result.type).toBe("export-success");
  expect(yields).toBeGreaterThan(0);
});

it("rejects additional paused exports and releases blocked work on termination", async () => {
  const runtime = new DocumentWorkerRuntime(executor);
  runtime.setNavigationActive(true);
  const request = {
    ...executor,
    baseModelRevision: null,
    exportGeneration: 1,
    modelRevision: 0,
    snapshot: snapshot(),
    type: "export-full" as const,
  };
  const blocked = runtime.execute(request);
  const settled = blocked.catch((error: unknown) => error);
  await expect(runtime.execute({ ...request, exportGeneration: 2 })).rejects.toThrow(
    "queue rejected export: busy",
  );
  runtime.terminate();
  expect(await settled).toBeInstanceOf(Error);
  runtime.setNavigationActive(false);
  expect(runtime.instrumentation.fragmentBuilds).toBe(0);
});
