import { afterEach, expect, it, vi } from "vitest";
import * as primitives from "../../../../../src/domain/geometry/primitives";
import { BoundedVersionLru } from "../../../../../src/domain/cache/bounded-version-lru";
import { markStoredStroke } from "../../../../../src/domain/elements/stroke-replacement-proof";
import { ScenePathCache } from "../../../../../src/rendering/scene/content/path-cache";
import { SceneGeometryAliases } from "../../../../../src/rendering/scene/content/scene-geometry-aliases";
import { hydrateRuntimeStroke } from "../../../../fixtures/domain/runtime-stroke-store";
import { createTestStroke } from "../../../../fixtures/persistence/worker-snapshot";

afterEach(() => vi.restoreAllMocks());

it("memoizes private canonical headers only while their geometry remains retained", async () => {
  const { stroke } = await hydrateRuntimeStroke(createTestStroke());
  const cache = new ScenePathCache(1);
  const parts = cache.build(stroke);
  const signatureWork = vi.spyOn(primitives, "roundCanonical");
  const deleted = vi.spyOn(WeakMap.prototype, "delete");
  expect(cache.read(stroke)).toBe(parts);
  expect(cache.ownsPrepared(stroke, parts)).toBe(true);
  expect(signatureWork).not.toHaveBeenCalled();
  cache.retain("replacement", 1, [{ d: "M0 0Z", paint: "fill" }]);
  expect(deleted).toHaveBeenCalledWith(stroke);
  expect(cache.read(stroke)).toBeUndefined();
  expect(signatureWork).toHaveBeenCalledTimes(2);
  cache.setRetentionEnabled(false);
  signatureWork.mockClear();
  expect(cache.read(stroke)).toBeUndefined();
  expect(signatureWork).toHaveBeenCalledTimes(2);
  expect(cache.cacheMemoryUsage()).toBe(0);
  cache.setRetentionEnabled(true);
  const rebuilt = cache.build(stroke);
  signatureWork.mockClear();
  expect(cache.read(stroke)).toBe(rebuilt);
  expect(signatureWork).not.toHaveBeenCalled();
  cache.release();
  expect(deleted.mock.calls.filter(([key]) => key === stroke)).toHaveLength(2);
  expect(cache.read(stroke)).toBeUndefined();
  expect(signatureWork).toHaveBeenCalledTimes(2);
  expect(cache.cacheMemoryUsage()).toBe(0);
});

it("bounds private signature memo ownership to one weak header per retained contour", async () => {
  const { stroke } = await hydrateRuntimeStroke(createTestStroke());
  const copied = markStoredStroke(Object.freeze({ ...stroke, id: "copy" }));
  const cache = new ScenePathCache();
  const parts = cache.build(stroke);
  const signatureWork = vi.spyOn(primitives, "roundCanonical");
  const deleted = vi.spyOn(WeakMap.prototype, "delete");
  expect(cache.read(copied)).toBe(parts);
  expect(signatureWork).toHaveBeenCalledTimes(2);
  expect(deleted).toHaveBeenCalledWith(stroke);
  signatureWork.mockClear();
  expect(cache.read(copied)).toBe(parts);
  expect(signatureWork).not.toHaveBeenCalled();
  expect(cache.read(stroke)).toBe(parts);
  expect(signatureWork).toHaveBeenCalledTimes(2);
  expect(deleted).toHaveBeenCalledWith(copied);
  expect(cache.statistics().entries).toBe(1);
  cache.release();
  expect(deleted.mock.calls.filter(([key]) => key === stroke)).toHaveLength(2);
  expect(cache.cacheMemoryUsage()).toBe(0);
});

it("rechecks mutable public style, pivot, offset and sample ownership on the same header", () => {
  const stroke = createTestStroke();
  Object.freeze(stroke.points);
  const cache = new ScenePathCache();
  const original = cache.build(stroke);
  const style = stroke.style;
  style.width = 4;
  const wider = cache.build(stroke);
  expect(wider).not.toBe(original);
  stroke.pivot.x = 40;
  expect(cache.read(stroke)).toBeUndefined();
  stroke.offset = { x: 30, y: 0 };
  expect(cache.read(stroke)).toBe(wider);
  stroke.offset.x = 20;
  expect(cache.read(stroke)).toBeUndefined();
  stroke.points = [...stroke.points];
  expect(cache.read(stroke)).toBeUndefined();
  cache.release();
});

it("passes one actual cache access through read or take to retain without duplicate alias touches", async () => {
  const { stroke } = await hydrateRuntimeStroke(createTestStroke());
  const cache = new ScenePathCache();
  const parts = cache.build(stroke);
  cache.retain(stroke.id, 1, parts);
  const get = vi.spyOn(BoundedVersionLru.prototype, "get");
  const retainAlias = vi.spyOn(SceneGeometryAliases.prototype, "retain");
  expect(cache.has(stroke.id, 1)).toBe(true);
  expect(cache.has(stroke.id, 2)).toBe(false);
  expect(get).not.toHaveBeenCalled();
  expect(cache.take(stroke.id, 1)).toBe(parts);
  cache.retain(stroke.id, 1, parts);
  expect(get).toHaveBeenCalledTimes(2);
  expect(retainAlias).not.toHaveBeenCalled();
  get.mockClear();
  expect(cache.read(stroke, undefined, 1)).toBe(parts);
  cache.retain(stroke.id, 1, parts);
  expect(get).toHaveBeenCalledTimes(2);
  expect(retainAlias).toHaveBeenCalledOnce();
  get.mockClear();
  retainAlias.mockClear();
  cache.retain(stroke.id, 1, parts);
  expect(get).toHaveBeenCalledTimes(2);
  expect(retainAlias).toHaveBeenCalledOnce();
  cache.release();
});

it("invalidates the access handoff when another lazy preparation changes LRU order", () => {
  const cache = new ScenePathCache(2);
  const first = [{ d: "M0 0Z", paint: "fill" as const }];
  cache.retain("first", 1, first);
  cache.retain("second", 1, [{ d: "M1 1Z", paint: "fill" }]);
  expect(cache.take("first", 1)).toBe(first);
  cache.retainPrepared("third", 1, { geometry: [], geometryMemoryBytes: 0 });
  cache.retain("first", 1, first);
  cache.retain("fourth", 1, [{ d: "M4 4Z", paint: "fill" }]);
  expect(cache.take("first", 1)).toBe(first);
  expect(cache.take("third", 1)).toBeUndefined();
  cache.release();
});

it("keeps availability probes from promoting bounded aliases", () => {
  const cache = new ScenePathCache(2);
  const parts = [{ d: "M0 0Z", paint: "fill" as const }];
  cache.retain("first", 1, parts);
  cache.retain("second", 1, parts);
  expect(cache.has("first", 1)).toBe(true);
  cache.retain("third", 1, parts);
  expect(cache.has("first", 1)).toBe(false);
  expect(cache.take("second", 1)).toBe(parts);
  expect(cache.take("third", 1)).toBe(parts);
  cache.release();
  expect(cache.cacheMemoryUsage()).toBe(0);
});

it("promotes a different alias even when its contour has just been accessed", () => {
  const cache = new ScenePathCache(3);
  const parts = [{ d: "M0 0Z", paint: "fill" as const }];
  for (const id of ["first", "second", "third"]) cache.retain(id, 1, parts);
  expect(cache.take("third", 1)).toBe(parts);
  cache.retain("first", 1, parts);
  cache.retain("fourth", 1, parts);
  expect(cache.has("second", 1)).toBe(false);
  expect(cache.take("first", 1)).toBe(parts);
  cache.release();
});
