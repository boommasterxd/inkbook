import { beforeAll, describe, expect, it } from "vitest";

import { ElementStore } from "../../../src/domain/store/public";
import { expectTiming } from "../timing-assertions";
import {
  bottomMarker,
  createPageHeightStore,
  pageHeightPercentile,
} from "./page-height-performance-fixture";

let store: ElementStore;

beforeAll(async () => {
  store = await createPageHeightStore(ElementStore);
});

describe("automatic page-height mutation performance", () => {
  it("updates a 10,000-stroke bottom extent without scanning the store", async ({ annotate }) => {
    const baseline = store.getMaximumBottom();
    if (baseline === undefined) throw new Error("The fixture has no bottom extent.");
    const durations: number[] = [];

    for (let operation = 0; operation < 250; operation += 1) {
      const marker = bottomMarker(operation, baseline + 1_000);
      let started = performance.now();
      store.create(marker);
      expect(store.getMaximumBottom()).toBe(store.get(marker.id)?.bounds.maxY);
      durations.push(performance.now() - started);

      started = performance.now();
      store.remove([marker.id]);
      expect(store.getMaximumBottom()).toBe(baseline);
      durations.push(performance.now() - started);
    }

    const p99 = pageHeightPercentile(durations, 0.99);
    expectTiming(p99, 4);
    expect(store.instrumentation.fullStoreScans).toBe(0);
    await annotate(`500 bottom-extent mutations: p99=${p99.toFixed(3)} ms, fullScans=0`);
  });
});
