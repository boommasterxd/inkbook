import * as strokeGeometry from "../../../../src/domain/geometry/stroke-path";
import * as elementGeometry from "../../../../src/domain/geometry/element-path";
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
  DETACHED_ELEMENT_CACHE_MAX_BYTES,
  PATH_CACHE_MAX_ENTRIES,
} from "../../../../src/rendering/scene/constants";
import { ScenePathCache } from "../../../../src/rendering/scene/path-cache";
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
    workScheduler: scheduler.workScheduler,
    store,
  });

  scheduler.runAll();
  for (const offset of BATCH_OFFSETS.slice(1)) showOffset(renderer, scheduler, offset);
  showOffset(renderer, scheduler, 3_000);
  expect(renderer.instrumentation().pathCacheEntries).toBe(2_100);

  renderer.resetInstrumentation();
  const creation = vi.spyOn(fakeNode(renderer.svg).ownerDocument, "createElementNS");
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  const insertion = vi.spyOn(content, "insertBefore");
  expect(content.nodes).toHaveLength(0);
  showOffset(renderer, scheduler, 0);

  expect(renderer.instrumentation()).toMatchObject({
    geometryBuilds: 0,
    detachedCacheHits: 0,
    contentGeometryWrites: BATCH_SIZE,
    contentAttributeWrites: BATCH_SIZE * 8,
    domEntrants: BATCH_SIZE,
    domExits: 0,
  });
  expect(insertion).toHaveBeenCalled();
  expect(content.nodes).toHaveLength(BATCH_SIZE);
  insertion.mockRestore();
  expect(creation.mock.calls.filter(([, tag]) => tag === "path" || tag === "g")).toHaveLength(
    BATCH_SIZE,
  );
  creation.mockRestore();
  await annotate("2,100 retained contours, 700 new roots, 0 contour rebuilds", "performance");

  // Cross the documented entry capacity and verify eviction through renderer ownership.
  const batches = Math.ceil(PATH_CACHE_MAX_ENTRIES / BATCH_SIZE);
  for (let batch = 3; batch <= batches; batch += 1) {
    const offset = batch * 1_000;
    populateBatch(store, batch, offset);
    showOffset(renderer, scheduler, offset);
    expect(renderer.mountedCount).toBe(BATCH_SIZE);
    expect(renderer.instrumentation().pathCacheEntries).toBeLessThanOrEqual(PATH_CACHE_MAX_ENTRIES);
    expect(renderer.instrumentation().pathCacheBytes).toBeLessThanOrEqual(25 * 1_024 * 1_024);
  }
  showOffset(renderer, scheduler, (batches + 1) * 1_000);
  expect(renderer.instrumentation().pathCacheEntries).toBe(PATH_CACHE_MAX_ENTRIES);
  // Every entry accounts for at least 576 bytes plus 512 bytes for its first root.
  expect(renderer.instrumentation().detachedCacheEntries).toBeLessThanOrEqual(
    Math.floor(DETACHED_ELEMENT_CACHE_MAX_BYTES / 1_088),
  );
  expect(renderer.instrumentation().detachedCacheBytes).toBeLessThanOrEqual(
    DETACHED_ELEMENT_CACHE_MAX_BYTES,
  );
  expect(content.nodes).toHaveLength(0);
  renderer.destroy();
  expect(renderer.instrumentation().pathCacheEntries).toBe(0);
  expect(renderer.instrumentation().detachedCacheEntries).toBe(0);
  expect(scheduler.pendingCount).toBe(0);
});

it("retires and restores 10,000 immutable contours within the existing cache without rebuilding", () => {
  const cache = new ScenePathCache();
  const elements = Array.from({ length: 10_000 }, (_, index) => {
    const element = indexedStroke(index);
    const points =
      index === 0
        ? [...PRESSURE_REFERENCE[3]!.points]
        : [...element.points, element.pivot.x + 10, element.pivot.y + 10, 1];
    Object.freeze(points);
    return {
      ...element,
      points,
      style: { ...element.style, width: index === 0 ? (22 as const) : (2 as const) },
    };
  });
  const build = vi.spyOn(elementGeometry, "buildElementPathParts");
  const contour = vi.spyOn(intersections, "intersectPressureBoundaries");
  try {
    const parts = elements.map((element) => cache.build(element));
    const geometryWork = build.mock.calls.length;
    expect(geometryWork).toBeGreaterThan(0);
    elements.forEach((element, index) => cache.retain(element.id, 1, parts[index]!));
    expect(cache.statistics()).toMatchObject({ entries: 10_000, evictions: 0 });
    expect(contour.mock.calls.length).toBeGreaterThan(0);
    contour.mockClear();
    for (const element of elements) {
      cache.invalidate(element.id);
      expect(cache.take(element.id, 1)).toBeUndefined();
    }
    expect(cache.statistics()).toMatchObject({ entries: 10_000, evictions: 0 });
    expect(cache.cacheMemoryUsage()).toBeLessThanOrEqual(25 * 1_024 * 1_024);
    elements.forEach((element, index) => {
      expect(cache.read(element)).toBe(parts[index]);
      cache.retain(element.id, 2, parts[index]!);
    });
    for (const element of elements) {
      expect(cache.take(element.id, 2)).toBe(cache.read(element));
      expect(cache.build(element)).toBe(cache.read(element));
    }
    expect(contour).not.toHaveBeenCalled();
    expect(build).toHaveBeenCalledTimes(geometryWork);
    cache.release();
    expect(cache.cacheMemoryUsage()).toBe(0);
  } finally {
    build.mockRestore();
    contour.mockRestore();
  }
});

it("invalidates detached nodes and releases them without additional DOM removals", () => {
  const store = new FakeSceneStore();
  const first = fakeRectangleRecord("delete", 0, 10);
  const second = fakeRectangleRecord("change", 1, 20);
  store.records.set(first.id, first);
  store.records.set(second.id, second);
  const { renderer, scheduler } = createSceneFixture(PAGE, store);
  scheduler.runAll();
  showOffset(renderer, scheduler, 3_000);
  expect(renderer.instrumentation().detachedCacheEntries).toBe(2);
  store.records.delete(first.id);
  renderer.applyDelta({ affected: [{ id: first.id, domains: ["geometry"] }] });
  expect(renderer.instrumentation().detachedCacheEntries).toBe(1);
  store.records.set(second.id, { ...second, geometryVersion: 2 });
  renderer.applyDelta({ affected: [{ id: second.id, domains: ["geometry"] }] });
  expect(renderer.instrumentation().detachedCacheEntries).toBe(0);
  scheduler.runAll();
  showOffset(renderer, scheduler, 0);
  showOffset(renderer, scheduler, 3_000);
  expect(renderer.instrumentation().detachedCacheEntries).toBe(1);
  const remove = vi.spyOn(FakeNode.prototype, "remove");
  renderer.setActiveDocumentMemoryPressure(true);
  expect(remove).not.toHaveBeenCalled();
  expect(renderer.instrumentation().detachedCacheBytes).toBe(0);
  scheduler.runAll();
  expect(renderer.instrumentation().detachedCacheBytes).toBe(0);
  remove.mockRestore();
  showOffset(renderer, scheduler, 0);
  showOffset(renderer, scheduler, 3_000);
  expect(renderer.instrumentation().detachedCacheEntries).toBe(0);
  renderer.destroy();
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
    workScheduler: scheduler.workScheduler,
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
    workScheduler: scheduler.workScheduler,
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
  const remove = vi.spyOn(FakeNode.prototype, "remove");
  try {
    let frames = 0;
    while (scheduler.pendingCount > 0) {
      expect(frames++).toBeLessThan(100);
      remove.mockClear();
      scheduler.runNext();
      expect(remove.mock.calls.length).toBeLessThanOrEqual(64);
    }
  } finally {
    remove.mockRestore();
  }
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
    const intersectPressureBoundaries = intersections.intersectPressureBoundaries;
    const boundary = vi.spyOn(intersections, "intersectPressureBoundaries");
    try {
      const expected = buildElementPathParts(element);
      const canonicalIntersections = boundary.mock.calls.length;
      expect(canonicalIntersections).toBeGreaterThan(0);
      boundary.mockClear();
      const store = new FakeSceneStore();
      store.records.set(element.id, createSceneRecord(element));
      const { renderer, scheduler } = createSceneFixture(PAGE, store);
      // Charge real union intersections; extra scheduler observations must not consume work.
      if (cancel) {
        boundary.mockImplementation((...args) => {
          const result = intersectPressureBoundaries(...args);
          scheduler.time += 1;
          return result;
        });
      }
      const deadline = vi.spyOn(scheduler.workScheduler, "deadline");
      let frames = 0;
      while (renderer.mountedCount === 0) {
        const before = boundary.mock.calls.length;
        renderer.setCamera({ x: 0, zoom: 1 + (frames % 2) * 0.001 });
        deadline.mockClear();
        scheduler.runNext();
        // Empty reserve adoption must not spend another deadline read before visible union work.
        if (cancel) expect(deadline).toHaveBeenCalledOnce();
        // At most 64 preparation steps per slice, each with 4,096 resumptions; clipping tests
        // at most four peer boundaries between resumptions in the canonical union.
        expect(boundary.mock.calls.length - before).toBeLessThanOrEqual(64 * 4096 * 4);
        frames += 1;
        expect(frames).toBeLessThan(100);
        if (cancel && boundary.mock.calls.length > 0) break;
      }
      deadline.mockRestore();
      if (cancel) {
        expect(renderer.mountedCount).toBe(0);
        expect(boundary.mock.calls.length).toBeGreaterThan(0);
        expect(boundary.mock.calls.length).toBeLessThan(canonicalIntersections);
      }
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

it.each([1, 100])(
  "keeps %s mounted stroke shapes through durable move, undo, and redo",
  (count) => {
    const store = new FakeSceneStore();
    const original = Array.from({ length: count }, (_, index) => {
      const stroke = indexedStroke(index);
      const points = Array.from(stroke.points);
      Object.freeze(points);
      const element = { ...stroke, points };
      const record = createSceneRecord(element, index);
      store.records.set(element.id, record);
      return record;
    });
    const { renderer, scheduler } = createSceneFixture(PAGE, store);
    scheduler.runAll();
    expect(renderer.mountedCount).toBe(count);
    const boundary = vi.spyOn(intersections, "intersectPressureBoundaries");
    const geometry = vi.spyOn(strokeGeometry, "strokeCenterAt");
    try {
      for (const delta of [20, 0, 20]) {
        renderer.resetInstrumentation();
        const before = original.map(({ id }) => store.get(id)!.element);
        for (const record of original) {
          const element = record.element;
          if (element.kind !== "stroke") throw new Error("Expected stroke.");
          const next = {
            ...element,
            offset: { x: delta, y: delta },
            pivot: { x: element.pivot.x + delta, y: element.pivot.y + delta },
          };
          store.records.set(element.id, {
            ...createSceneRecord(next, record.rank),
            geometryVersion: (store.get(element.id)?.geometryVersion ?? 0) + 1,
          });
        }
        renderer.applyDelta({
          affected: original.map(({ id }, index) => ({
            id,
            before: before[index]!,
            after: store.get(id)!.element,
            domains: ["geometry"],
          })),
        });
        scheduler.runAll();
        expect(renderer.instrumentation().geometryBuilds).toBe(0);
        if (count === 1) expect(renderer.instrumentation().motionGeometryTransitions).toBe(1);
        expect(boundary).not.toHaveBeenCalled();
        expect(geometry).not.toHaveBeenCalled();
        expect(renderer.mountedCount).toBe(count);
      }
      renderer.destroy();
      expect(scheduler.pendingCount).toBe(0);
    } finally {
      boundary.mockRestore();
      geometry.mockRestore();
    }
  },
);
