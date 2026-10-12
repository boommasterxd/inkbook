import { afterEach, expect, it, vi } from "vitest";
import * as primitives from "../../../../src/domain/geometry/primitives";
import * as geometry from "../../../../src/domain/geometry/element-path";
import { BoundedVersionLru } from "../../../../src/domain/cache/bounded-version-lru";
import { ElementStore } from "../../../../src/domain/store/public";
import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { ScenePathCache } from "../../../../src/rendering/scene/path-cache";
import { SceneGeometryAliases } from "../../../../src/rendering/scene/scene-geometry-aliases";
import { PATH_CACHE_MAX_BYTES } from "../../../../src/rendering/scene/constants";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import * as pressureOutline from "../../../../src/domain/geometry/pressure-outline";
import { translatedStroke } from "../../../../src/domain/geometry/stroke-position";
import { createHistoryContourScene, drainHistoryFrames } from "../../../fixtures/rendering/scene";
import { fakeNode } from "../../../unit/rendering/scene/fakes";

afterEach(() => vi.restoreAllMocks());

it("clears previews after cache release without retaining unchanged canonical contours", async () => {
  const fixture = await createHistoryContourScene();
  const { store, renderer, scheduler, ids } = fixture;
  const records = ids.map((id) => store.get(id)!);
  const groups = fakeNode(renderer.svg).nodes[1]!.nodes[4]!.nodes.slice(0, ids.length);
  expect(groups).toHaveLength(ids.length);
  const canonical = groups.map((group) => ({
    attributes: [...group.attributes],
    paths: group.nodes.map((path) => [...path.attributes]),
  }));
  renderer.setActiveDocumentMemoryPressure(true);
  renderer.setActiveDocumentMemoryPressure(false);
  expect(renderer.instrumentation().pathCacheEntries).toBe(0);
  const probe = vi.spyOn(ScenePathCache.prototype, "has");
  const complete = vi.spyOn(ScenePathCache.prototype, "completePreparation");
  const alias = vi.spyOn(SceneGeometryAliases.prototype, "retain");
  const outline = vi.spyOn(pressureOutline, "visitPreparedPressureOutline");
  const build = vi.spyOn(geometry, "buildElementPathParts");
  try {
    renderer.setElementPreviews(
      records.map((record) => {
        const element = record.element as InkElementV1;
        if (element.kind !== "stroke") throw new Error("Expected a stroke fixture.");
        return translatedStroke(element, { x: 2, y: 3 });
      }),
      1,
    );
    renderer.flushPointerFeedbackFrame();
    for (const group of groups) expect(group.attributes.get("transform")).toBe("translate(2 3)");
    renderer.clearElementPreviews();
    scheduler.runAll();
    expect(probe).not.toHaveBeenCalled();
    expect(complete.mock.calls.length).toBe(0);
    expect(alias.mock.calls.length).toBe(0);
    expect(outline).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(renderer.instrumentation().pathCacheEntries).toBe(0);
    ids.forEach((id, index) => expect(store.get(id)).toBe(records[index]));
    expect(
      groups.map((group) => ({
        attributes: [...group.attributes],
        paths: group.nodes.map((path) => [...path.attributes]),
      })),
    ).toEqual(canonical);
  } finally {
    fixture.dispose();
  }
  expect(renderer.memoryUsage()).toEqual({ pathCacheBytes: 0, motionCacheBytes: 0 });
  expect(scheduler.pendingCount).toBe(0);
});

it.each([false, true])(
  "retains edited contours once in a 10,000-stroke store (Store prepared: %s)",
  async (storePrepared) => {
    const fixture = await createHistoryContourScene();
    const { store, renderer, scheduler, ids } = fixture;
    const complete = vi.spyOn(ScenePathCache.prototype, "completePreparation");
    const alias = vi.spyOn(SceneGeometryAliases.prototype, "retain");
    const outline = vi.spyOn(pressureOutline, "visitPreparedPressureOutline");
    try {
      for (const id of ids) {
        const element = store.get(id)!.element as InkElementV1;
        if (element.kind !== "stroke") throw new Error("Expected a stroke fixture.");
        store.replace(id, { ...element, style: { ...element.style, width: 8 } });
        if (storePrepared) {
          const record = store.get(id)!;
          store.pressureGeometry(id, record.geometryVersion).publishPath!(
            geometry.buildElementPathParts(record.element as InkElementV1),
          );
        }
      }
      scheduler.runAll();
      expect(outline).toHaveBeenCalledTimes(storePrepared ? 0 : ids.length);
      expect(complete).toHaveBeenCalledTimes(ids.length);
      expect(alias).toHaveBeenCalledTimes(ids.length);
      complete.mockClear();
      alias.mockClear();
      outline.mockClear();
      const moved = ids.map((id) => store.get(id)!.element as InkElementV1);
      for (const element of moved) {
        if (element.kind !== "stroke") throw new Error("Expected a stroke fixture.");
        store.replace(element.id, { ...element, style: { ...element.style, width: 2 } });
      }
      scheduler.runAll();
      expect(complete).not.toHaveBeenCalled();
      expect(alias).toHaveBeenCalledTimes(ids.length);
      alias.mockClear();
      for (const element of moved) store.replace(element.id, element);
      scheduler.runAll();
      expect(outline).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(alias).toHaveBeenCalledTimes(ids.length);
      alias.mockClear();
      outline.mockClear();
      for (const id of ids) {
        const element = store.get(id)!.element as InkElementV1;
        if (element.kind !== "stroke") throw new Error("Expected a stroke fixture.");
        store.replace(id, translatedStroke(element, { x: 1, y: 1 }));
      }
      scheduler.runAll();
      expect(outline).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledTimes(ids.length);
      expect(alias).toHaveBeenCalledTimes(ids.length);
      complete.mockClear();
      alias.mockClear();
      const deletion = store.removeWithHistory(ids);
      if (deletion === null) throw new Error("Expected a removal transition.");
      scheduler.runAll();
      const restored = await fixture.prepareReplay(deletion.transition, "reverse");
      expect(restored.status).toBe("prepared");
      store.commitPreparedElementMutation(restored.token!);
      drainHistoryFrames(scheduler);
      expect(outline).not.toHaveBeenCalled();
      // Restoration probes and final mount share the contour; each ID owns one versioned alias.
      expect(complete).not.toHaveBeenCalled();
      expect(alias.mock.calls.length).toBeLessThanOrEqual(ids.length * 2);
      expect(renderer.instrumentation().pathCacheBytes).toBeLessThanOrEqual(PATH_CACHE_MAX_BYTES);
    } finally {
      fixture.dispose();
    }
    expect(renderer.memoryUsage()).toEqual({ pathCacheBytes: 0, motionCacheBytes: 0 });
    expect(scheduler.pendingCount).toBe(0);
  },
);

it("restores 10,000 canonical strokes with one contour and alias access and no signature work", () => {
  const sources = Array.from({ length: 10_000 }, (_, index) => indexedStroke(index));
  const store = new ElementStore(sources);
  const elements = sources.map(({ id }) => store.get(id)!.element as InkElementV1);
  const cache = new ScenePathCache();
  const parts = elements.map((element) => cache.build(element));
  elements.forEach((element, index) => cache.retain(element.id, 1, parts[index]!));
  expect(cache.statistics()).toMatchObject({ entries: 10_000, evictions: 0 });
  for (const element of elements) cache.invalidate(element.id);

  const signatureWork = vi.spyOn(primitives, "roundCanonical");
  const build = vi.spyOn(geometry, "buildElementPathParts");
  const get = vi.spyOn(BoundedVersionLru.prototype, "get");
  const alias = vi.spyOn(SceneGeometryAliases.prototype, "retain");
  elements.forEach((element, index) => {
    expect(cache.read(element, undefined, 2)).toBe(parts[index]);
    cache.retain(element.id, 2, parts[index]!);
  });
  expect(get).toHaveBeenCalledTimes(10_000);
  expect(alias).toHaveBeenCalledTimes(10_000);
  get.mockClear();
  alias.mockClear();

  elements.forEach((element, index) => {
    expect(cache.has(element.id, 2)).toBe(true);
    expect(cache.take(element.id, 2)).toBe(parts[index]);
    cache.retain(element.id, 2, parts[index]!);
  });
  expect(signatureWork).not.toHaveBeenCalled();
  expect(build).not.toHaveBeenCalled();
  expect(get).toHaveBeenCalledTimes(20_000);
  expect(alias).not.toHaveBeenCalled();
  expect(cache.statistics()).toMatchObject({ entries: 10_000, evictions: 0 });
  expect(cache.cacheMemoryUsage()).toBeLessThanOrEqual(PATH_CACHE_MAX_BYTES);

  const deleted = vi.spyOn(WeakMap.prototype, "delete");
  cache.setRetentionEnabled(false);
  const headers = new Set<object>(elements);
  expect(deleted.mock.calls.filter(([key]) => headers.has(key))).toHaveLength(10_000);
  expect(cache.cacheMemoryUsage()).toBe(0);
  get.mockClear();
  expect(cache.has(elements[0]!.id, 2)).toBe(false);
  expect(cache.read(elements[0]!)).toBeUndefined();
  expect(signatureWork).toHaveBeenCalledTimes(2);
  expect(get).not.toHaveBeenCalled();
  cache.release();
  expect(cache.statistics().entries).toBe(0);
  expect(cache.cacheMemoryUsage()).toBe(0);
});
