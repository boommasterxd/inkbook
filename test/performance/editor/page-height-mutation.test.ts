import { beforeAll, describe, expect, it } from "vitest";

import type { BoxShapeElementV1 } from "../../../src/domain/schema/public";
import { ElementStore } from "../../../src/domain/store/public";
import { createStandardRuntimeDomainFixture } from "../domain/standard-domain-fixture";
import { timingBudget } from "../timing-budget";
import { pageHeightPercentile } from "./page-height-performance-fixture";

let store: ElementStore;

beforeAll(async () => {
  const builder = ElementStore.createBuilder({
    shouldYield: () => false,
    yieldControl: async () => Promise.resolve(),
  });
  expect(await builder.appendOwnedRuntime(createStandardRuntimeDomainFixture().elements)).toBe(
    "accepted",
  );
  const built = await builder.finalize();
  if (built === null) throw new Error("The page-height fixture was cancelled.");
  store = built;
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
    expect(p99).toBeLessThanOrEqual(timingBudget(4));
    expect(store.instrumentation.fullStoreScans).toBe(0);
    await annotate(`500 bottom-extent mutations: p99=${p99.toFixed(3)} ms, fullScans=0`);
  });
});

function bottomMarker(index: number, y: number): BoxShapeElementV1 {
  return {
    createdAt: index,
    height: 100,
    id: `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    kind: "rectangle",
    pivot: { x: 50, y: y + 50 },
    rotation: 0,
    style: {
      fillColor: null,
      fillOpacity: 0,
      outlineColor: { type: "theme-text" },
      outlineOpacity: 1,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
    width: 100,
    x: 0,
    y,
  };
}
