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

afterEach(() => vi.restoreAllMocks());

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
