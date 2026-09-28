import { describe, expect, it, vi } from "vitest";

import { MutationPreparationScheduler } from "../../../../src/domain/store/mutation-preparation-scheduler";

describe("mutation preparation scheduling", () => {
  it("continues past the former work quota while the shared deadline has budget", async () => {
    const yieldControl = vi.fn(async () => undefined);
    const scheduler = new MutationPreparationScheduler({ shouldYield: () => false, yieldControl });
    for (let index = 0; index < 2_049; index += 1) {
      expect(scheduler.checkpoint()).toBe(true);
    }
    expect(yieldControl).not.toHaveBeenCalled();
  });

  it("honors the shared deadline before starting work", async () => {
    const yieldControl = vi.fn(async () => undefined);
    const scheduler = new MutationPreparationScheduler({ shouldYield: () => true, yieldControl });
    expect(scheduler.checkpoint()).toBe(false);
    expect(yieldControl).not.toHaveBeenCalled();
    expect(await scheduler.resume()).toBe(true);
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
      expect(scheduler.checkpoint()).toBe(false);
      expect(await scheduler.resume()).toBe(false);
      expect(yieldControl).toHaveBeenCalledTimes(initial ? 0 : 1);
    },
  );
});
