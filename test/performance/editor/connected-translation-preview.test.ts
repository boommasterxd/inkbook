import { describe, expect, it } from "vitest";

import { resolveConnectedTranslationPreview } from "../../../src/domain/store/public";
import { percentile } from "../domain/domain-scenarios";
import { timingBudget } from "../timing-budget";
import {
  CONNECTED_DEPENDENT_COUNT,
  createConnectedTranslationFixture,
} from "./connected-translation-fixture";

describe("connected translation preview performance", () => {
  it("visits only cached reverse dependents for a dense selection move", () => {
    const { selectedIds, store, target } = createConnectedTranslationFixture();
    const durations: number[] = [];
    resolveConnectedTranslationPreview(store, [target.id], selectedIds, { x: 1, y: 1 });
    store.resetInstrumentation();

    for (let run = 0; run < 100; run += 1) {
      const startedAt = performance.now();
      const preview = resolveConnectedTranslationPreview(store, [target.id], selectedIds, {
        x: run + 2,
        y: run + 2,
      });
      durations.push(performance.now() - startedAt);
      expect(preview).toHaveLength(CONNECTED_DEPENDENT_COUNT);
    }

    expect(percentile(durations, 0.95)).toBeLessThanOrEqual(timingBudget(8));
    expect(store.instrumentation).toMatchObject({
      fullStoreScans: 0,
      reverseDependencyVisits: CONNECTED_DEPENDENT_COUNT * durations.length,
    });
  });
});
