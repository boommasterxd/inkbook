import { expect, it, vi } from "vitest";
import { VisibilityClassification } from "../../../../src/rendering/scene/visibility-classification";
import {
  createSceneFixture,
  createViewportRectangleStore,
} from "../../../fixtures/rendering/scene";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";

it("keeps removal reuse after an offscreen deletion without an artificial scene commit", () => {
  const store = createViewportRectangleStore(3, (rank) => (rank === 0 ? 2_000 : 10));
  const records = [...store.records.values()];
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store);
  renderer.setReducedMotion(true);
  scheduler.runAll();
  expect(renderer.mountedCount).toBe(2);
  const classify = vi.spyOn(VisibilityClassification.prototype, "collect");
  try {
    for (const record of records.slice(0, 2)) {
      store.records.delete(record.id);
      renderer.applyDelta({
        affected: [
          {
            id: record.id,
            before: record.element,
            after: null,
            beforeBounds: record.bounds,
            afterBounds: null,
            domains: ["visibility", "order"],
          },
        ],
      });
      scheduler.runAll();
      expect(classify).not.toHaveBeenCalled();
    }
    expect(renderer.mountedIds("content")).toEqual([records[2]!.id]);
  } finally {
    classify.mockRestore();
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

it.each(["classification", "publication"] as const)(
  "falls back when a canonical removal interrupts unfinished %s",
  (phase) => {
    const store = createViewportRectangleStore(600, () => 10);
    const { renderer, scheduler, document } = createSceneFixture(NAVIGATION_PAGE, store);
    renderer.setReducedMotion(true);
    const record = [...store.records.values()][0]!;
    const get = store.get.bind(store);
    const reads = vi.spyOn(store, "get").mockImplementation((id) => {
      if (phase === "classification") scheduler.time += 1;
      return get(id);
    });
    const create = document.createElementNS.bind(document);
    const writes = vi.spyOn(document, "createElementNS").mockImplementation((...args) => {
      if (phase === "publication") scheduler.time += 1;
      return create(...args);
    });
    const classify = vi.spyOn(VisibilityClassification.prototype, "collect");
    try {
      scheduler.runNext();
      expect(renderer.mountedCount).toBeLessThan(600);
      store.records.delete(record.id);
      classify.mockClear();
      renderer.applyDelta({
        affected: [
          {
            id: record.id,
            before: record.element,
            after: null,
            beforeBounds: record.bounds,
            afterBounds: null,
            domains: ["order", "visibility"],
          },
        ],
      });
      reads.mockImplementation(get);
      writes.mockImplementation(create);
      scheduler.runAll(200);
      expect(classify).toHaveBeenCalled();
      expect(renderer.mountedCount).toBe(599);
      expect(renderer.mountedIds("content")).not.toContain(record.id);
      renderer.setViewport({ height: 1_000, left: 0, top: 20, width: 2_048 });
      scheduler.runAll(200);
      expect(renderer.mountedCount).toBe(599);
    } finally {
      reads.mockRestore();
      writes.mockRestore();
      classify.mockRestore();
      renderer.destroy();
    }
    expect(scheduler.pendingCount).toBe(0);
  },
);

it.each(["page", "layout", "transform", "element", "progressive", "generation"] as const)(
  "discards removal reuse when %s changes before its publication frame",
  (change) => {
    const store = createViewportRectangleStore(3, () => 10);
    const [removed, survivor] = [...store.records.values()];
    const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store);
    renderer.setReducedMotion(true);
    scheduler.runAll();
    const classify = vi.spyOn(VisibilityClassification.prototype, "collect");
    try {
      store.records.delete(removed!.id);
      renderer.applyDelta({
        affected: [
          {
            id: removed!.id,
            before: removed!.element,
            after: null,
            beforeBounds: removed!.bounds,
            afterBounds: null,
            domains: ["order", "visibility"],
          },
        ],
      });
      if (change === "page") renderer.setPage({ ...NAVIGATION_PAGE }, 2);
      if (change === "layout") renderer.invalidateLayout();
      if (change === "transform") renderer.setPreviewTransform([survivor!.id], "translate(1 0)", 1);
      if (change === "element") renderer.setElementPreviews([survivor!.element], 1);
      if (change === "progressive")
        renderer.setProgressiveElementPreviews([survivor!.id], () => survivor!.element, 1);
      if (change === "generation") renderer.replaceGeneration();
      scheduler.runAll(200);
      expect(classify).toHaveBeenCalled();
      expect(renderer.mountedIds("content")).not.toContain(removed!.id);
      renderer.clearPreviewTransforms();
      renderer.clearElementPreviews();
      scheduler.runAll(200);
      expect(renderer.mountedCount).toBe(2);
    } finally {
      classify.mockRestore();
      renderer.destroy();
    }
    expect(scheduler.pendingCount).toBe(0);
  },
);
