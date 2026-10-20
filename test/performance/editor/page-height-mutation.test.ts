import { beforeAll, describe, expect, it, vi } from "vitest";

import { ElementStore } from "../../../src/domain/store/public";
import { SpatialMap } from "../../../src/domain/spatial/spatial-map";
import { SpatialSlots } from "../../../src/domain/spatial/slot-storage";
import { bottomMarker, createPageHeightStore } from "./page-height-performance-fixture";

let store: ElementStore;

beforeAll(async () => {
  store = await createPageHeightStore(ElementStore);
});

describe("automatic page-height mutation performance", () => {
  it("updates a 10,000-stroke bottom extent without scanning the store", () => {
    const baseline = store.getMaximumBottom();
    if (baseline === undefined) throw new Error("The fixture has no bottom extent.");
    const entries = vi.spyOn(SpatialMap.prototype, "get");
    const slots = vi.spyOn(SpatialSlots.prototype, "get");
    const readExtent = () => {
      entries.mockClear();
      slots.mockClear();
      const bottom = store.getMaximumBottom();
      // One removed heap head, then the current head and its final validation.
      expect(entries.mock.calls.length).toBeLessThanOrEqual(3);
      expect(slots).not.toHaveBeenCalled();
      return bottom;
    };
    try {
      for (let operation = 0; operation < 3; operation += 1) {
        const marker = bottomMarker(operation, baseline + 1_000);
        store.create(marker);
        const expectedBottom = store.get(marker.id)?.bounds.maxY;
        expect(readExtent()).toBe(expectedBottom);
        store.remove([marker.id]);
        expect(readExtent()).toBe(baseline);
      }
      expect(store.instrumentation.fullStoreScans).toBe(0);
    } finally {
      entries.mockRestore();
      slots.mockRestore();
    }
  });
});
