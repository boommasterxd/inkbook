import { describe, expect, it, vi } from "vitest";

import { MutationPreparationScheduler } from "../../../../src/domain/store/mutation-preparation-scheduler";

describe("mutation preparation scheduling", () => {
  it.each([
    [1, 2048],
    [16, 128],
  ])("bounds work at cost %s", async (cost, capacity) => {
    const yieldControl = vi.fn(async () => undefined);
    const scheduler = new MutationPreparationScheduler({ shouldYield: () => false, yieldControl });
    for (let index = 0; index < capacity; index += 1) {
      expect(await scheduler.checkpoint(cost)).toBe(true);
    }
    expect(yieldControl).not.toHaveBeenCalled();
    expect(await scheduler.checkpoint(cost)).toBe(true);
    expect(yieldControl).toHaveBeenCalledTimes(1);
  });

  it("honors the external deadline while guaranteeing progress", async () => {
    const yieldControl = vi.fn(async () => undefined);
    const scheduler = new MutationPreparationScheduler({ shouldYield: () => true, yieldControl });
    expect(await scheduler.checkpoint()).toBe(true);
    expect(yieldControl).not.toHaveBeenCalled();
    expect(await scheduler.checkpoint()).toBe(true);
    expect(yieldControl).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "cancels before or during a yield: initially cancelled=%s",
    async (initial) => {
      let cancelled = initial;
      const yieldControl = vi.fn(async () => {
        cancelled = true;
      });
      const scheduler = new MutationPreparationScheduler({
        isCancelled: () => cancelled,
        shouldYield: () => true,
        yieldControl,
      });
      expect(await scheduler.checkpoint()).toBe(!initial);
      expect(await scheduler.checkpoint()).toBe(false);
      expect(yieldControl).toHaveBeenCalledTimes(initial ? 0 : 1);
    },
  );
});
