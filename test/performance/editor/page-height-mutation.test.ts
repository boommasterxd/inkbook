import { beforeAll, describe, expect, it } from "vitest";

import { ElementStore } from "../../../src/domain/store/public";
import { bottomMarker, createPageHeightStore } from "./page-height-performance-fixture";

let store: ElementStore;

beforeAll(async () => {
  store = await createPageHeightStore(ElementStore);
});

describe("automatic page-height mutation performance", () => {
  it("updates a 10,000-stroke bottom extent without scanning the store", () => {
    const baseline = store.getMaximumBottom();
    if (baseline === undefined) throw new Error("The fixture has no bottom extent.");
    let incorrectCreatedExtents = 0;
    let incorrectRemovedExtents = 0;

    for (let operation = 0; operation < 250; operation += 1) {
      const marker = bottomMarker(operation, baseline + 1_000);
      store.create(marker);
      const createdBottom = store.getMaximumBottom();
      const expectedBottom = store.get(marker.id)?.bounds.maxY;
      if (!Object.is(createdBottom, expectedBottom)) incorrectCreatedExtents += 1;
      store.remove([marker.id]);
      const removedBottom = store.getMaximumBottom();
      if (!Object.is(removedBottom, baseline)) incorrectRemovedExtents += 1;
    }

    expect(incorrectCreatedExtents).toBe(0);
    expect(incorrectRemovedExtents).toBe(0);

    expect(store.instrumentation.fullStoreScans).toBe(0);
  });
});
