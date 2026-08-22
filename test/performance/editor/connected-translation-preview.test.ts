import { describe, expect, it } from "vitest";

import { ElementStore, resolveConnectedTranslationPreview } from "../../../src/domain/store/public";
import { indexedStroke } from "../../fixtures/editor/stroke";
import { connectedLine, rectangle } from "../../unit/domain/store/fixtures";
import { percentile } from "../domain/domain-scenarios";
import { timingBudget } from "../timing-budget";

const DEPENDENT_COUNT = 512;
const SELECTED_STROKE_COUNT = 10_000;

describe("connected translation preview performance", () => {
  it("visits only cached reverse dependents for a dense selection move", () => {
    const target = rectangle();
    const dependents = Array.from({ length: DEPENDENT_COUNT }, (_, index) => ({
      ...connectedLine(target),
      createdAt: index + 2,
      id: `00000000-0000-4000-8001-${String(index).padStart(12, "0")}`,
    }));
    const strokes = Array.from({ length: SELECTED_STROKE_COUNT }, (_, index) =>
      indexedStroke(index),
    );
    const selectedIds = new Set([target.id, ...strokes.map(({ id }) => id)]);
    const store = new ElementStore([target, ...dependents, ...strokes]);
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
      expect(preview).toHaveLength(DEPENDENT_COUNT);
    }

    expect(percentile(durations, 0.95)).toBeLessThanOrEqual(timingBudget(8));
    expect(store.instrumentation).toMatchObject({
      fullStoreScans: 0,
      reverseDependencyVisits: DEPENDENT_COUNT * durations.length,
    });
  });
});
