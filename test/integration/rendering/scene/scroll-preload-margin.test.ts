import { expect, it } from "vitest";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import {
  createPendingScenePathStore,
  createSceneFixture,
  createSceneRecord,
  createViewportRectangleStore,
} from "../../../fixtures/rendering/scene";

const VIEWPORT = { height: 100, left: 0, top: 1_000, width: 100 };

it("keeps an initial unlock exact even when its margin changes before release", () => {
  const store = createViewportRectangleStore(3, (rank) => 750 + rank * 300);
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, VIEWPORT, {
    deferInitialOverscan: true,
    scrollPreloadMarginPx: 100,
  });
  renderer.setScrollPreloadMarginPx(800);
  scheduler.runAll();
  expect(renderer.mountedIds("content")).toEqual(["entry-1"]);
  expect(renderer.sceneCommitProof).toBeDefined();
  renderer.releaseInitialOverscan();
  scheduler.runAll();
  expect(renderer.mountedIds("content")).toEqual(["entry-0", "entry-1", "entry-2"]);
  renderer.destroy();
  expect(scheduler.pendingCount).toBe(0);
});

it.each([NaN, Infinity, -Infinity, 99, 801, 100.5])(
  "rejects invalid margin %s before surface creation and without changing a live scene",
  (margin) => {
    const store = createViewportRectangleStore(1, () => 1_000);
    expect(() =>
      createSceneFixture(NAVIGATION_PAGE, store, VIEWPORT, { scrollPreloadMarginPx: margin }),
    ).toThrow(RangeError);
    const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, VIEWPORT);
    scheduler.runAll();
    expect(() => renderer.setScrollPreloadMarginPx(margin)).toThrow(RangeError);
    expect(scheduler.pendingCount).toBe(0);
    expect(renderer.mountedCount).toBe(1);
    renderer.destroy();
    expect(() => renderer.setScrollPreloadMarginPx(300)).toThrow("destroyed");
  },
);

it("accepts integer margins between slider steps and retargets consecutive changes once", () => {
  const store = createViewportRectangleStore(4, (rank) => 200 + rank * 300);
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, VIEWPORT, {
    scrollPreloadMarginPx: 101,
  });
  scheduler.runAll();
  expect(renderer.mountedIds("content")).toEqual(["entry-3"]);
  renderer.setScrollPreloadMarginPx(800);
  renderer.setScrollPreloadMarginPx(301);
  expect(scheduler.pendingCount).toBe(1);
  scheduler.runAll();
  expect(renderer.mountedIds("content")).toEqual(["entry-2", "entry-3"]);
  renderer.destroy();
  expect(scheduler.pendingCount).toBe(0);
});

it.each([undefined, null, "300"])("rejects non-number live margin %s", (margin) => {
  const store = createViewportRectangleStore(1, () => 1_000);
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, VIEWPORT);
  scheduler.runAll();
  expect(() => renderer.setScrollPreloadMarginPx(margin as unknown as number)).toThrow(RangeError);
  expect(scheduler.pendingCount).toBe(0);
  expect(renderer.mountedCount).toBe(1);
  renderer.destroy();
});

it("aborts pending remote overscan when a smaller margin excludes it, then cleans a new request", () => {
  const { store, signals } = createPendingScenePathStore();
  const cold = {
    ...indexedStroke(0),
    pivot: { x: 20, y: 1_500 },
    points: [20, 1_500, 0.5, 30, 1_500, 0.5],
  };
  store.records.set(cold.id, createSceneRecord(cold));
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, VIEWPORT, {
    scrollPreloadMarginPx: 800,
  });
  scheduler.runAll();
  expect(signals).toHaveLength(1);
  expect(signals[0]!.aborted).toBe(false);
  renderer.setScrollPreloadMarginPx(100);
  scheduler.runAll();
  expect(signals[0]!.aborted).toBe(true);
  expect(renderer.mountedCount).toBe(0);
  expect(renderer.instrumentation().pathCacheEntries).toBe(0);
  renderer.setScrollPreloadMarginPx(800);
  scheduler.runAll();
  expect(signals).toHaveLength(2);
  expect(signals[1]!.aborted).toBe(false);
  renderer.destroy();
  expect(signals[1]!.aborted).toBe(true);
  expect(scheduler.pendingCount).toBe(0);
});
