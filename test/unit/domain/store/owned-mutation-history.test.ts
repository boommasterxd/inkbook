import { describe, expect, it } from "vitest";

import { ElementStore } from "../../../../src/domain/store/public";
import { elementMutationPayloadBytes } from "../../../../src/domain/store/mutation-payload";
import { MutationPreparationScheduler } from "../../../../src/domain/store/mutation-preparation-scheduler";
import {
  captureOwnedMutationHistory,
  prepareOwnedMutationHistory,
} from "../../../../src/domain/store/owned-mutation-history";
import { highlighter } from "./fixtures";

describe("owned mutation history retention", () => {
  it("accounts for private records and leaves order-only records unretained", () => {
    const element = highlighter();
    const store = new ElementStore([element]);
    const original = store.get(element.id)!;
    const delta = store.remove([element.id])!;
    const retained = captureOwnedMutationHistory(delta);
    expect(retained.forward.size).toBe(0);
    expect(retained.reverse.get(element.id)).toBe(original);
    expect(retained.payloadBytes).toBe(272 + elementMutationPayloadBytes(original.element));
    const orderOnly = captureOwnedMutationHistory({
      ...delta,
      changes: [{ id: element.id, before: original, after: original, domains: ["order"] }],
    });
    expect(orderOnly.forward.size).toBe(0);
    expect(orderOnly.reverse.size).toBe(0);
    expect(orderOnly.payloadBytes).toBe(64);
  });

  it("discards incomplete ownership preparation on cancellation and can retry", async () => {
    const element = highlighter();
    const store = new ElementStore([element]);
    const delta = store.remove([element.id])!;
    let cancelled = false;
    expect(
      await prepareOwnedMutationHistory(
        delta,
        new MutationPreparationScheduler({
          isCancelled: () => cancelled,
          shouldYield: () => true,
          yieldControl: async () => {
            cancelled = true;
          },
        }),
      ),
    ).toBe("cancelled");
    const prepared = await prepareOwnedMutationHistory(
      delta,
      new MutationPreparationScheduler({
        shouldYield: () => false,
        yieldControl: async () => undefined,
      }),
    );
    expect(prepared).toEqual(captureOwnedMutationHistory(delta));
  });
});
