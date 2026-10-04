import { describe, expect, it, vi } from "vitest";

import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import type { BoxShapeElementV1, PageV1 } from "../../../../src/domain/schema/public";
import { SvgSceneRenderer } from "../../../../src/rendering/scene";
import { QueryCostStore } from "../../../fixtures/rendering/scene";
import type { SceneViewport } from "../../../../src/rendering/scene/types";
import {
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  FakeScheduler,
  asElement,
  fakeRectangleRecord,
  fakeNode,
} from "../../../unit/rendering/scene/fakes";

const PAGE: PageV1 = {
  activeBufferLines: 3,
  background: { type: "none" },
  innerWidth: 2000,
  lockedBufferLines: 1,
  margin: 24.3,
};

class AdvancingScheduler extends FakeScheduler {
  public override now(): number {
    const current = this.time;
    this.time += 0.5;
    return current;
  }
}

describe("resumable scene reconciliation", () => {
  it("keeps background geometry frozen while a larger scene is clipped", () => {
    const scheduler = new FakeScheduler();
    const store = new FakeSceneStore();
    const squarePage: PageV1 = { ...PAGE, background: { spacing: 50, type: "squares" } };
    let viewport: SceneViewport = { height: 400, left: 0, top: 0, width: 100 };
    const renderer = createRenderer(store, scheduler, {
      page: squarePage,
      readViewport: () => viewport,
    });
    renderer.setPage(squarePage, 500);
    scheduler.runAll();
    const background = fakeNode(renderer.svg).nodes[1]!.nodes[1]!;
    const completeGeometry = background.attributes.get("d");
    renderer.resetInstrumentation();

    viewport = { ...viewport, height: 100 };
    renderer.invalidateLayout();
    scheduler.runAll();

    expect(background.attributes.get("d")).toBe(completeGeometry);
    expect(renderer.instrumentation().backgroundBuilds).toBe(0);

    viewport = { ...viewport, height: 60 };
    renderer.invalidateLayout();
    scheduler.runAll();
    expect(renderer.instrumentation().backgroundBuilds).toBe(0);
  });

  it("keeps full background geometry independent of the visible viewport", verifyGrowthCoverage);

  it("queries changed viewport edges within the same spatial cells", () => {
    const scheduler = new FakeScheduler();
    const store = new FakeSceneStore();
    store.records.set("edge", fakeRectangleRecord("edge", 0, 190));
    const renderer = createRenderer(store, scheduler);
    scheduler.runAll();
    expect(renderer.mountedCount).toBe(0);
    renderer.resetInstrumentation();

    renderer.setCamera({ x: -50, zoom: 1 });
    scheduler.runAll();

    expect(renderer.mountedIds("content")).toEqual(["edge"]);
    expect(renderer.instrumentation()).toMatchObject({
      spatialQueries: 2,
      visibilityCandidateVisits: 1,
    });
  });

  it("retains sorted visibility when camera movement crosses the hysteresis reserve", () => {
    const scheduler = new FakeScheduler();
    const store = new FakeSceneStore();
    store.records.set("stable", fakeRectangleRecord("stable", 0, 10));
    const renderer = createRenderer(store, scheduler);
    scheduler.runAll();
    renderer.resetInstrumentation();

    renderer.setCamera({ x: -50, zoom: 1 });
    scheduler.runAll();

    expect(renderer.mountedIds("content")).toEqual(["stable"]);
    expect(renderer.instrumentation()).toMatchObject({
      domEntrants: 0,
      domExits: 0,
      spatialQueries: 2,
      visibilityCandidateVisits: 0,
    });
  });

  it("defers viewport classification when a query consumes the shared frame deadline", () => {
    const scheduler = new AdvancingScheduler();
    const store = new QueryCostStore(scheduler);
    const expected = populateRectangles(store, 12);
    const renderer = createRenderer(store, scheduler);

    scheduler.runNext();

    expect(renderer.mountedCount).toBe(0);
    expect(renderer.instrumentation()).toMatchObject({
      mountSlices: 0,
      spatialQueries: 1,
      visibilityReconcileVisits: 0,
    });

    scheduler.runAll();

    expect(renderer.mountedIds("content")).toEqual(expected);
    expect(renderer.instrumentation().spatialQueries).toBe(1);
  });
});

describe("delta-aware visibility candidates", () => {
  it("reuses candidates when geometry and visibility changes stay on one side of the cell range", () => {
    const scheduler = new FakeScheduler();
    const store = new FakeSceneStore();
    const inside = fakeRectangleRecord("inside", 0, 10);
    store.records.set(inside.id, inside);
    const renderer = createRenderer(store, scheduler);
    scheduler.runAll();
    renderer.resetInstrumentation();

    const outside = fakeRectangleRecord("outside", 1, 600);
    store.records.set(outside.id, outside);
    renderer.applyDelta({
      affected: [
        {
          after: outside.element,
          before: null,
          domains: ["visibility"],
          id: outside.id,
        },
      ],
    });
    scheduler.runAll();
    expect(renderer.instrumentation()).toMatchObject({
      spatialQueries: 0,
      visibilityCandidateCacheHits: 1,
    });

    renderer.resetInstrumentation();
    const movedInside = fakeRectangleRecord(inside.id, 0, 30);
    store.records.set(inside.id, { ...movedInside, geometryVersion: 2 });
    renderer.applyDelta({
      affected: [
        {
          after: movedInside.element,
          before: inside.element,
          domains: ["geometry"],
          id: inside.id,
        },
      ],
    });
    scheduler.runAll();
    expect(renderer.instrumentation()).toMatchObject({
      spatialQueries: 0,
      visibilityCandidateCacheHits: 1,
    });

    renderer.resetInstrumentation();
    const movedOutside = fakeRectangleRecord(inside.id, 0, 600);
    store.records.set(inside.id, { ...movedOutside, geometryVersion: 3 });
    renderer.applyDelta({
      affected: [
        {
          after: movedOutside.element,
          before: movedInside.element,
          domains: ["geometry"],
          id: inside.id,
        },
      ],
    });
    scheduler.runAll();
    expect(renderer.instrumentation().spatialQueries).toBe(1);
    expect(renderer.mountedIds("content")).toEqual([]);
  });
});

describe("scene reconciliation frame priority", () => {
  it("keeps a page-height update pending until its complete scene frame", () => {
    const scheduler = new FakeScheduler();
    const store = new FakeSceneStore();
    const committed = vi.fn();
    const renderer = createRenderer(store, scheduler, { onSceneCommitted: committed });
    scheduler.runAll();
    committed.mockClear();

    renderer.setPage(PAGE, 600);

    expect(renderer.hasPendingSceneCommit).toBe(true);
    expect(committed).not.toHaveBeenCalled();
    scheduler.runAll();
    expect(renderer.hasPendingSceneCommit).toBe(false);
    expect(committed).toHaveBeenCalledOnce();
  });

  it("defers initial readiness until visibility and background are committed", () => {
    const scheduler = new AdvancingScheduler();
    const store = new FakeSceneStore();
    populateRectangles(store, 20);
    const committed = vi.fn();
    const document = new FakeDocument();
    const renderer = new SvgSceneRenderer({
      container: asElement(new FakeNode(document, "div")),
      layout: { readViewport: () => ({ height: 100, left: 0, top: 0, width: 100 }) },
      onSceneCommitted: committed,
      page: PAGE,
      workScheduler: scheduler.workScheduler,
      store,
    });
    renderer.setPage({ ...PAGE, background: { spacing: 25, type: "dots" } }, 500);

    scheduler.runNext();

    expect(renderer.hasPendingSceneCommit).toBe(true);
    expect(committed).not.toHaveBeenCalled();
    expect(renderer.instrumentation()).toMatchObject({
      backgroundBuilds: 0,
      motionEntrances: 0,
      motionFrames: 0,
    });

    scheduler.runAll();

    expect(renderer.hasPendingSceneCommit).toBe(false);
    expect(committed).toHaveBeenCalledOnce();
    expect(renderer.instrumentation()).toMatchObject({
      backgroundBuilds: 1,
      motionEntrances: 0,
    });
    expect(renderer.instrumentation().backgroundBudgetDeferrals).toBeGreaterThan(0);
  });
});

describe("resumable scene reconciliation after invalidation", () => {
  it("reuses prepared paths without publishing stale nodes before a dense remount", () => {
    const scheduler = new FakeScheduler();
    const store = new FakeSceneStore();
    populateRectangles(store, 1_201);
    const renderer = createRenderer(store, scheduler);

    scheduler.runNext();
    expect(renderer.mountedCount).toBe(64);
    const prepared = renderer.instrumentation().geometryBuilds;
    expect(prepared).toBeGreaterThan(0);
    expect(prepared).toBeLessThan(store.records.size);

    showViewport(renderer, scheduler, 10_000);
    expect(renderer.mountedCount).toBe(0);

    renderer.resetInstrumentation();
    showViewport(renderer, scheduler, 0);

    expect(renderer.mountedCount).toBe(store.records.size);
    expect(renderer.instrumentation()).toMatchObject({
      pathCacheEvictions: 0,
      detachedCacheHits: prepared,
      spatialQueries: 1,
    });
  });

  it("resorts pending ranks and applies preview state when the delayed element mounts", () => {
    const scheduler = new FakeScheduler();
    const store = new FakeSceneStore();
    const originalOrder = populateRectangles(store, 1_201);
    const renderer = createRenderer(store, scheduler);
    scheduler.runNext();
    const promotedId = originalOrder[originalOrder.length - 1]!;
    const demotedId = originalOrder[0]!;
    store.records.set(promotedId, { ...store.records.get(promotedId)!, rank: -1 });
    store.records.set(demotedId, { ...store.records.get(demotedId)!, rank: 1_201 });
    renderer.setPreviewTransform([promotedId], "translate(5 0)", 1);
    renderer.applyDelta({
      affected: [
        { domains: ["order"], id: promotedId },
        { domains: ["order"], id: demotedId },
      ],
    });

    scheduler.runAll();

    const expected = [promotedId, ...originalOrder.slice(1, -1), demotedId];
    const contentGroup = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
    expect(renderer.mountedIds("content")).toEqual(expected);
    expect(contentGroup.nodes.map((node) => node.attributes.get("d"))).toEqual(
      expected.map((id) => buildElementPathParts(store.records.get(id)!.element)[0]!.d),
    );
    expect(contentGroup.nodes[0]?.attributes.get("transform")).toBe("translate(5 0)");
    expect(renderer.instrumentation().spatialQueries).toBe(1);
  });
});

describe("pending scene state replacement", () => {
  it("time-slices mounted geometry, order, and exit work at the shared frame deadline", () => {
    const scheduler = new AdvancingScheduler();
    const store = new FakeSceneStore();
    const ids = populateRectangles(store, 20);
    const renderer = createRenderer(store, scheduler);
    scheduler.runAll();

    renderer.resetInstrumentation();
    for (const id of ids) {
      const record = store.records.get(id)!;
      const element = record.element as BoxShapeElementV1;
      store.records.set(id, {
        ...record,
        element: { ...element, width: element.width + 1 },
        geometryVersion: 2,
      });
    }
    renderer.applyDelta({ affected: ids.map((id) => ({ domains: ["geometry"], id })) });
    scheduler.runNext();
    expect(renderer.instrumentation().geometryBuilds).toBeGreaterThan(0);
    expect(renderer.instrumentation().geometryBuilds).toBeLessThan(ids.length);
    scheduler.runAll();
    expect(renderer.instrumentation().geometryBuilds).toBe(ids.length);

    renderer.resetInstrumentation();
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index]!;
      store.records.set(id, { ...store.records.get(id)!, rank: ids.length - index });
    }
    renderer.applyDelta({ affected: ids.map((id) => ({ domains: ["order"], id })) });
    scheduler.runNext();
    expect(scheduler.pendingCount).toBe(1);
    scheduler.runAll();
    const committedOrder = [...ids].reverse();
    expect(renderer.mountedIds("content")).toEqual(committedOrder);
    expect(renderer.instrumentation().domFragmentRuns).toBe(1);

    renderer.setViewport({ height: 100, left: 0, top: 10_000, width: 100 });
    scheduler.runNext();
    expect(renderer.mountedCount).toBeGreaterThan(0);
    expect(renderer.mountedCount).toBeLessThan(ids.length);
    const contentGroup = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
    expect(contentGroup.nodes).toHaveLength(ids.length);
    scheduler.runAll();
    expect(renderer.mountedCount).toBe(0);
  });

  it("replaces pending work after store additions, removals, and geometry changes", () => {
    const scheduler = new FakeScheduler();
    const store = new FakeSceneStore();
    const originalOrder = populateRectangles(store, 1_201);
    const renderer = createRenderer(store, scheduler);
    scheduler.runNext();
    const removedMountedId = originalOrder[0]!;
    const removedPendingId = originalOrder[originalOrder.length - 1]!;
    const changedPendingId = originalOrder[originalOrder.length - 2]!;
    const addedId = "replacement";
    store.records.delete(removedMountedId);
    store.records.delete(removedPendingId);
    store.records.set(addedId, fakeRectangleRecord(addedId, 2_000, 20));
    store.records.set(changedPendingId, {
      ...fakeRectangleRecord(changedPendingId, 1_199, 30),
      geometryVersion: 2,
    });
    renderer.applyDelta({
      affected: [
        { domains: ["visibility"], id: removedMountedId },
        { domains: ["visibility"], id: removedPendingId },
        { domains: ["visibility"], id: addedId },
        { domains: ["geometry"], id: changedPendingId },
      ],
    });

    scheduler.runAll();

    const expected = [...store.records.values()]
      .sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id))
      .map(({ id }) => id);
    expect(renderer.mountedIds("content")).toEqual(expected);
    expect(renderer.mountedCount).toBe(store.records.size);
    expect(renderer.instrumentation().spatialQueries).toBe(2);
  });
});

describe("active-document cache pressure", () => {
  it("releases and suppresses the offscreen path LRU until pressure clears", () => {
    const scheduler = new FakeScheduler();
    const store = new FakeSceneStore();
    store.records.set("a", fakeRectangleRecord("a", 0, 10));
    const renderer = createRenderer(store, scheduler);
    scheduler.runAll();

    showViewport(renderer, scheduler, 10_000);
    expect(renderer.instrumentation().pathCacheEntries).toBe(1);

    renderer.setActiveDocumentMemoryPressure(true);
    expect(renderer.instrumentation()).toMatchObject({
      pathCacheEntries: 0,
      pathCacheEvictions: 1,
    });
    showViewport(renderer, scheduler, 0);
    showViewport(renderer, scheduler, 10_000);
    expect(renderer.instrumentation().pathCacheEntries).toBe(0);

    renderer.setActiveDocumentMemoryPressure(false);
    showViewport(renderer, scheduler, 0);
    showViewport(renderer, scheduler, 10_000);
    expect(renderer.instrumentation().pathCacheEntries).toBe(1);
  });
});

function createRenderer(
  store: FakeSceneStore,
  scheduler: FakeScheduler,
  options: {
    readonly onSceneCommitted?: () => void;
    readonly page?: PageV1;
    readonly readViewport?: () => SceneViewport;
  } = {},
): SvgSceneRenderer {
  const document = new FakeDocument();
  return new SvgSceneRenderer({
    container: asElement(new FakeNode(document, "div")),
    layout: {
      readViewport: options.readViewport ?? (() => ({ height: 100, left: 0, top: 0, width: 100 })),
    },
    ...(options.onSceneCommitted === undefined
      ? {}
      : { onSceneCommitted: options.onSceneCommitted }),
    page: options.page ?? PAGE,
    workScheduler: scheduler.workScheduler,
    store,
  });
}

function verifyGrowthCoverage(): void {
  const scheduler = new FakeScheduler();
  const store = new FakeSceneStore();
  const squarePage: PageV1 = { ...PAGE, background: { spacing: 50, type: "squares" } };
  let viewport: SceneViewport = { height: 100, left: 0, top: 0, width: 100 };
  const renderer = createRenderer(store, scheduler, {
    page: squarePage,
    readViewport: () => viewport,
  });
  renderer.setPage(squarePage, 2_500);
  scheduler.runAll();
  const background = fakeNode(renderer.svg).nodes[1]!.nodes[1]!;
  const initialGeometry = background.attributes.get("d");
  renderer.resetInstrumentation();

  viewport = { ...viewport, height: 60 };
  renderer.invalidateLayout();
  scheduler.runAll();
  expect(background.attributes.get("d")).toBe(initialGeometry);
  expect(renderer.instrumentation().backgroundBuilds).toBe(0);

  viewport = { ...viewport, height: 800 };
  renderer.invalidateLayout();
  renderer.invalidateLayout();
  scheduler.runAll();

  expect(background.attributes.get("d")).toBe(initialGeometry);
  expect(renderer.instrumentation().backgroundBuilds).toBe(0);
}

function populateRectangles(store: FakeSceneStore, count: number): string[] {
  const ids: string[] = [];
  for (let rank = 0; rank < count; rank += 1) {
    const id = `rectangle-${rank.toString().padStart(4, "0")}`;
    ids.push(id);
    store.records.set(id, fakeRectangleRecord(id, rank, 10 + rank / 1_000));
  }
  return ids;
}

function showViewport(renderer: SvgSceneRenderer, scheduler: FakeScheduler, top: number): void {
  renderer.setViewport({ height: 100, left: 0, top, width: 100 });
  scheduler.runAll();
}
