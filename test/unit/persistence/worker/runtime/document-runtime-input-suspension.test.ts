import { expect, it } from "vitest";

import { createTestWorkScheduler } from "../../../../fixtures/persistence/work-scheduler";
import {
  DocumentWorkerRuntime,
  GestureAwareSliceScheduler,
} from "../../../../../src/persistence/worker/runtime/public";
import { executor, snapshot } from "./fixtures";

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
