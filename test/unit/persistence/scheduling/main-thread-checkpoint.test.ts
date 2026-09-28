import { expect, it } from "vitest";

import { createMainThreadCheckpoint } from "../../../../src/persistence/scheduling/main-thread-checkpoint";
import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";

it("waits for background work before checking the shared frame budget", async () => {
  const events: string[] = [];
  let releaseBackground = (): void => undefined;
  const workScheduler = createTestWorkScheduler({
    checkpoint: () => {
      events.push("shared-checkpoint");
      return Promise.resolve();
    },
  });
  const checkpoint = createMainThreadCheckpoint(workScheduler, () => {
    events.push("background-gate");
    return new Promise<void>((resolve) => {
      releaseBackground = resolve;
    });
  });

  const pending = checkpoint();
  expect(events).toEqual(["background-gate"]);
  releaseBackground();
  await pending;

  expect(events).toEqual(["background-gate", "shared-checkpoint"]);
});
