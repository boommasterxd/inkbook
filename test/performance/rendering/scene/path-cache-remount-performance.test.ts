import * as intersections from "../../../../src/domain/geometry/pressure-boundary-intersections";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { PRESSURE_REFERENCE } from "../../../fixtures/domain/pressure-reference";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { createSceneFixture, createSceneRecord } from "../../../fixtures/rendering/scene";
import { expect, it, vi } from "vitest";

import type { PageV1 } from "../../../../src/domain/schema/public";
import { SvgSceneRenderer } from "../../../../src/rendering/scene";
import { type SceneElementRecord } from "../../../../src/rendering/scene/types";
import {
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  FakeScheduler,
  asElement,
  fakeRectangleRecord,
  fakeNode,
} from "../../../unit/rendering/scene/fakes";

const BATCH_SIZE = 700;
const BATCH_OFFSETS = [0, 1_000, 2_000] as const;
const PAGE: PageV1 = {
  activeBufferLines: 3,
  background: { type: "none" },
  innerWidth: 2_000,
  lockedBufferLines: 1,
  margin: 24.3,
};

it("remounts a batch after retaining more than 2,048 paths without geometry rebuilds", async ({
  annotate,
}) => {
  const document = new FakeDocument();
  const scheduler = new FakeScheduler();
  const store = new FakeSceneStore();
  for (let batch = 0; batch < BATCH_OFFSETS.length; batch += 1) {
    const offset = BATCH_OFFSETS[batch]!;
    populateBatch(store, batch, offset);
  }
  const renderer = new SvgSceneRenderer({
    container: asElement(new FakeNode(document, "div")),
    layout: { readViewport: () => ({ height: 100, left: 0, top: 0, width: 100 }) },
    page: PAGE,
    scheduler,
    store,
  });

  scheduler.runAll();
  for (const offset of BATCH_OFFSETS.slice(1)) showOffset(renderer, scheduler, offset);
  showOffset(renderer, scheduler, 3_000);
  expect(renderer.instrumentation().pathCacheEntries).toBe(2_100);

  renderer.resetInstrumentation();
  showOffset(renderer, scheduler, 0);

  expect(renderer.instrumentation()).toMatchObject({
    geometryBuilds: 0,
    pathCacheHits: BATCH_SIZE,
  });
  await annotate("2,100 retained paths, 700 remount hits, 0 geometry builds", "performance");

  // Cross the documented entry capacity and verify eviction through renderer ownership.
  for (let batch = 3; batch < 6; batch += 1) {
    const offset = batch * 1_000;
    populateBatch(store, batch, offset);
    showOffset(renderer, scheduler, offset);
    expect(renderer.mountedCount).toBe(BATCH_SIZE);
    expect(renderer.instrumentation().pathCacheEntries).toBeLessThanOrEqual(4_096);
    expect(renderer.instrumentation().pathCacheBytes).toBeLessThanOrEqual(32 * 1_024 * 1_024);
  }
  showOffset(renderer, scheduler, 6_000);
  expect(renderer.instrumentation().pathCacheEntries).toBe(4_096);
  renderer.destroy();
  expect(renderer.instrumentation().pathCacheEntries).toBe(0);
  expect(scheduler.pendingCount).toBe(0);
});

it("counts exact paint writes and reuses background geometry across repaint work", async ({
  annotate,
}) => {
  const document = new FakeDocument();
  const scheduler = new FakeScheduler();
  const store = new FakeSceneStore();
  const initial = fakeRectangleRecord("painted", 0, 10);
  store.records.set(initial.id, initial);
  const linedPage: PageV1 = { ...PAGE, background: { spacing: 25, type: "squares" } };
  const renderer = new SvgSceneRenderer({
    container: asElement(new FakeNode(document, "div")),
    layout: { readViewport: () => ({ height: 100, left: 0, top: 0, width: 100 }) },
    page: linedPage,
    scheduler,
    store,
  });
  renderer.setPage(linedPage, 100);
  scheduler.runAll();

  if (initial.element.kind !== "rectangle") throw new Error("Expected a rectangle fixture.");
  const painted: SceneElementRecord = {
    ...initial,
    element: {
      ...initial.element,
      style: { ...initial.element.style, outlineOpacity: 0.5 },
    },
    paintVersion: 2,
  };
  store.records.set(initial.id, painted);
  renderer.resetInstrumentation();
  renderer.applyDelta({ affected: [{ domains: ["paint"], id: initial.id }] });
  scheduler.runAll();
  expect(renderer.instrumentation()).toMatchObject({
    contentAttributeWrites: 1,
    contentGeometryWrites: 0,
    geometryBuilds: 0,
  });

  store.records.set(initial.id, { ...painted, paintVersion: 3 });
  renderer.resetInstrumentation();
  renderer.applyDelta({ affected: [{ domains: ["paint"], id: initial.id }] });
  scheduler.runAll();
  expect(renderer.instrumentation().contentAttributeWrites).toBe(0);

  renderer.resetInstrumentation();
  renderer.setPage({ ...linedPage }, 100);
  scheduler.runAll();
  expect(renderer.instrumentation()).toMatchObject({
    backgroundBuilds: 0,
    backgroundCacheHits: 1,
    contentAttributeWrites: 0,
  });

  renderer.resetInstrumentation();
  renderer.setScheme("dark");
  scheduler.runAll();
  expect(renderer.instrumentation()).toMatchObject({
    backgroundBuilds: 0,
    contentAttributeWrites: 0,
    themeWrites: 1,
  });
  await annotate(
    "renderer writes: changedPaint=1, unchangedPaint=0, backgroundCacheHits=1, themeBuilds=0",
    "performance",
  );
});

it("builds a height-invariant spacing preview once and reuses its final geometry", async ({
  annotate,
}) => {
  const scheduler = new FakeScheduler();
  const renderer = new SvgSceneRenderer({
    container: asElement(new FakeNode(new FakeDocument(), "div")),
    layout: { readViewport: () => ({ height: 900, left: 0, top: 0, width: 1_000 }) },
    page: { ...PAGE, background: { spacing: 25, type: "squares" } },
    scheduler,
    store: new FakeSceneStore(),
  });
  scheduler.runAll();

  const medium: PageV1 = { ...PAGE, background: { spacing: 50, type: "squares" } };
  renderer.resetInstrumentation();
  renderer.setPage(medium, 2_688.6);
  scheduler.runAll();
  expect(renderer.instrumentation()).toMatchObject({
    backgroundBuilds: 1,
    contentAttributeWrites: 0,
    contentGeometryWrites: 0,
  });

  renderer.resetInstrumentation();
  renderer.setPage({ ...medium }, 2_688.6);
  scheduler.runAll();
  expect(renderer.instrumentation()).toMatchObject({
    backgroundBuilds: 0,
    backgroundCacheHits: 1,
    contentAttributeWrites: 0,
    contentGeometryWrites: 0,
  });
  await annotate(
    "height-invariant spacing preview=1 background build, final commit=0 builds, content writes=0",
    "performance",
  );
});

function showOffset(renderer: SvgSceneRenderer, scheduler: FakeScheduler, offset: number): void {
  renderer.setCamera({ x: -offset, zoom: 1 });
  scheduler.runAll();
}

function populateBatch(store: FakeSceneStore, batch: number, offset: number): void {
  for (let index = 0; index < BATCH_SIZE; index += 1) {
    const rank = batch * BATCH_SIZE + index;
    const id = `cached-path-${String(rank).padStart(4, "0")}`;
    store.records.set(id, fakeRectangleRecord(id, rank, offset + 10));
  }
}

it.each([false, true])(
  "bounds and reuses real handwriting union work during cold mounting (cancel: %s)",
  (cancel) => {
    const reference = PRESSURE_REFERENCE[3]!;
    const base = indexedStroke(1);
    const element = {
      ...base,
      points: reference.points,
      style: { ...base.style, width: 22 as const },
    };
    const boundary = vi.spyOn(intersections, "intersectPressureBoundaries");
    try {
      const expected = buildElementPathParts(element);
      const canonicalIntersections = boundary.mock.calls.length;
      expect(canonicalIntersections).toBeGreaterThan(0);
      boundary.mockClear();
      const store = new FakeSceneStore();
      store.records.set(element.id, createSceneRecord(element));
      const { renderer, scheduler } = createSceneFixture(PAGE, store);
      // Force cooperative pauses inside real union work, independently of step-count policy.
      const clock = cancel
        ? vi.spyOn(scheduler, "now").mockImplementation(() => scheduler.time++)
        : undefined;
      let frames = 0;
      while (renderer.mountedCount === 0) {
        const before = boundary.mock.calls.length;
        renderer.setCamera({ x: 0, zoom: 1 + (frames % 2) * 0.001 });
        scheduler.runNext();
        // At most 64 preparation steps per slice, each with 4,096 resumptions; clipping tests
        // at most four peer boundaries between resumptions in the canonical union.
        expect(boundary.mock.calls.length - before).toBeLessThanOrEqual(64 * 4096 * 4);
        frames += 1;
        expect(frames).toBeLessThan(100);
        if (cancel && boundary.mock.calls.length > 0) break;
      }
      clock?.mockRestore();
      if (cancel) expect(renderer.mountedCount).toBe(0);
      if (!cancel) {
        expect(boundary.mock.calls.length).toBe(canonicalIntersections);
        expect(renderer.instrumentation().geometryBuilds).toBe(1);
        // The retained path cache must reuse the completed output on remount.
        expect(
          fakeNode(renderer.svg).nodes[1]!.nodes[4]!.nodes[0]!.nodes[0]!.attributes.get("d"),
        ).toBe(expected[0]!.d);
        renderer.setCamera({ x: -100_000, zoom: 1 });
        scheduler.runAll();
        renderer.setCamera({ x: 0, zoom: 1 });
        scheduler.runAll();
        expect(boundary.mock.calls.length).toBe(canonicalIntersections);
      }
      const beforeDestroy = boundary.mock.calls.length;
      renderer.destroy();
      scheduler.runAll();
      expect(boundary.mock.calls.length).toBe(beforeDestroy);
      expect(renderer.memoryUsage()).toEqual({ pathCacheBytes: 0, motionCacheBytes: 0 });
      expect(scheduler.pendingCount).toBe(0);
    } finally {
      boundary.mockRestore();
    }
  },
);
