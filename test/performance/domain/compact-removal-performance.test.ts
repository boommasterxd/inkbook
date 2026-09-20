import { afterEach, describe, expect, it, vi } from "vitest";
import { UniformSpatialIndex } from "../../../src/domain/spatial/index";
import { DocumentCapacity } from "../../../src/domain/store/document-capacity";
import { ElementStoreOrdering } from "../../../src/domain/store/order-operations";
import { ElementStore } from "../../../src/domain/store/public";
import type { ElementMutation } from "../../../src/domain/store/types";
import { createStandardDomainFixture } from "./standard-domain-fixture";

const scheduler = { shouldYield: () => false, yieldControl: async () => undefined };
afterEach(() => vi.restoreAllMocks());

describe("compact removal work", () => {
  it.each([1, 128])(
    "bounds %i-element removal, undo and redo across a 10000-stroke document",
    async (count) => {
      const fixture = createStandardDomainFixture();
      const store = new ElementStore(fixture.elements);
      const untouched = store.get(fixture.strokeIds[9999]!);
      const materialize = vi.spyOn(ElementStoreOrdering.prototype, "materializeBand");
      const traversal = vi.spyOn(ElementStoreOrdering.prototype, "ids");
      const hydration = vi.spyOn(DocumentCapacity.prototype, "addInitial");
      const capacity = vi.spyOn(DocumentCapacity.prototype, "prepare");
      const insert = vi.spyOn(UniformSpatialIndex.prototype, "insertMany");
      const removal = vi.spyOn(UniformSpatialIndex.prototype, "removeMany");
      const extent = vi.spyOn(UniformSpatialIndex.prototype, "rebuildExtentStep");
      let mutation: ElementMutation = { removeIds: fixture.strokeIds.slice(100, 100 + count) };
      for (let pass = 0; pass < 3; pass += 1) {
        store.resetInstrumentation();
        capacity.mockClear();
        removal.mockClear();
        extent.mockClear();
        const prepared = await store.prepareElementMutation(mutation, scheduler);
        expect(prepared.status).toBe("prepared");
        const committed = store.commitPreparedElementMutation(prepared.token!);
        expect(committed.status).toBe("committed");
        expect(committed.delta?.changes).toHaveLength(count);
        expect(committed.transition?.payloadBytes).toBeLessThan(5000 * count);
        expect(committed.transition?.forward.bands).toBeUndefined();
        expect(committed.transition?.reverse.bands).toBeUndefined();
        expect(capacity).toHaveBeenCalledTimes(1);
        expect(capacity.mock.calls[0]![0].length + capacity.mock.calls[0]![1].length).toBe(count);
        expect(removal).toHaveBeenCalledTimes(1);
        expect(removal.mock.calls[0]![0]).toHaveLength(pass === 1 ? 0 : count);
        expect(extent).toHaveBeenCalledTimes(1);
        expect(extent).toHaveBeenCalledWith(256);
        expect(store.instrumentation.orderNodeVisits).toBeLessThanOrEqual(256 * count);
        expect(store.get(fixture.strokeIds[9999]!)).toBe(untouched);
        mutation = committed.transition!.reverse;
      }
      expect(materialize).not.toHaveBeenCalled();
      expect(traversal).not.toHaveBeenCalled();
      expect(hydration).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
    },
  );

  it("cancels a prepared removal without publishing or visiting commit boundaries", async () => {
    const fixture = createStandardDomainFixture();
    const store = new ElementStore(fixture.elements);
    let cancelled = false;
    const prepared = await store.prepareElementMutation(
      { removeIds: [fixture.strokeIds[0]!] },
      { ...scheduler, isCancelled: () => cancelled },
    );
    const remove = vi.spyOn(UniformSpatialIndex.prototype, "removeMany");
    const publish = vi.fn();
    store.subscribe(publish);
    cancelled = true;
    expect(store.commitPreparedElementMutation(prepared.token!).status).toBe("cancelled");
    expect(remove).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(store.size).toBe(fixture.elements.length);
  });
});
