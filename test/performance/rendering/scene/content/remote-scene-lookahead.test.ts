import { expect, it, vi } from "vitest";
import { RemoteScenePaths } from "../../../../../src/rendering/scene/content/remote-scene-paths";
import {
  MAX_PREPARED_SCENE_PATH_IDS,
  MAX_PREPARED_SCENE_PATH_BYTES,
} from "../../../../../src/domain/geometry/prepared-scene-paths";
import type { ScenePathPreparationObserver } from "../../../../../src/domain/geometry/prepared-scene-paths";
import { createTestStroke } from "../../../../fixtures/persistence/worker-snapshot";
import { dirtyGeometryScene } from "../../../../fixtures/rendering/dirty-geometry-scene";
import { contentPaths } from "../../../../fixtures/rendering/selection-runs";
import { fakeNode } from "../../../../unit/rendering/scene/fakes";

it("publishes cold pan entrants while mounted canonical catch-up also advances", async () => {
  const cold = Array.from({ length: 300 }, (_, index) => ({
    ...createTestStroke(),
    id: `00000000-0000-4000-8000-${String(900_000 + index).padStart(12, "0")}`,
    offset: { x: 0, y: index === 299 ? 600 : 500 },
  }));
  const visibleCold = new Set(cold.slice(0, -1).map(({ id }) => id));
  const scene = dirtyGeometryScene(1_100, 1_100, undefined, {
    transformStroke: (stroke) => ({
      ...stroke,
      points: [10, 10, 0.5, 10, 1_000, 1],
      pivot: { x: 10, y: 505 },
    }),
    additionalElements: cold,
  });
  const roots = contentPaths(fakeNode(scene.renderer.svg));
  const previousPaths = roots.map((root) => root.getAttribute("d"));
  const dirtyIds = new Set(scene.original.map(({ id }) => id));
  const viewportIds = new Set([...dirtyIds, ...visibleCold]);
  const expected = new Map<string, string>();
  const changedRoots = () =>
    roots.filter((root, index) => root.getAttribute("d") !== previousPaths[index]).length;
  try {
    expect(scene.renderer.mountedIds("content")).toEqual([...dirtyIds]);
    scene.replace();
    scene.scheduler.runAll();
    scene.renderer.setViewport({ left: 0, top: 450, width: 100, height: 100 });
    scene.scheduler.runAll();
    for (let index = 0; index < scene.requests.length; index += 1) {
      expect(index).toBeLessThan(20);
      const request = scene.requests[index]!;
      expect(request.signal.aborted).toBe(false);
      expect(request.ids.length).toBeLessThanOrEqual(MAX_PREPARED_SCENE_PATH_IDS);
      expect(request.options!.maxBytes).toBeLessThanOrEqual(MAX_PREPARED_SCENE_PATH_BYTES);
      const split = request.options!.visibleCount!;
      expect(request.ids.slice(0, split).every((id) => viewportIds.has(id))).toBe(true);
      expect(request.ids.slice(split).every((id) => !viewportIds.has(id))).toBe(true);
      for (const path of scene.deliver(request)) expected.set(path.id, path.parts[0]!.d);
      await Promise.resolve();
      await Promise.resolve();
      scene.scheduler.runAll();
      if (index === 1) {
        expect(scene.renderer.mountedIds("content").some((id) => visibleCold.has(id))).toBe(true);
        expect(changedRoots()).toBeGreaterThan(1);
        expect(changedRoots()).toBeLessThan(dirtyIds.size);
      }
    }
    const requested = scene.requests.flatMap(({ ids }) => ids);
    expect(requested).toHaveLength(dirtyIds.size + cold.length);
    expect(new Set(requested).size).toBe(requested.length);
    const mounted = scene.renderer.mountedIds("content");
    const paths = contentPaths(fakeNode(scene.renderer.svg));
    expect(mounted).toHaveLength(dirtyIds.size + cold.length);
    expect(paths.map((path) => path.getAttribute("d"))).toEqual(
      mounted.map((id) => expected.get(id)),
    );
    expect(scene.scheduler.pendingCount).toBe(0);
  } finally {
    scene.dispose();
  }
  expect(scene.renderer.memoryUsage()).toEqual({ pathCacheBytes: 0, motionCacheBytes: 0 });
});

it("preserves capacity lookahead through repeated unchanged retargets with one active request", async () => {
  const records = Array.from({ length: 1_024 }, (_, rank) => ({
    id: `stroke-${rank}`,
    element: { ...createTestStroke(), id: `stroke-${rank}` },
    geometryVersion: 0,
    paintVersion: 0,
    band: "content" as const,
    rank,
    bounds: { minX: 0, minY: 0, maxX: 20, maxY: 20 },
  }));
  const indexed = new Map(records.map((record) => [record.id, record]));
  const retarget = vi.fn();
  const requested: string[][] = [];
  let observer!: ScenePathPreparationObserver;
  let finish!: () => void;
  let active = 0;
  const remote = new RemoteScenePaths({
    get: (id) => indexed.get(id),
    query: () => undefined,
    prepareScenePaths: (ids, signal, progress) => {
      expect(++active).toBe(1);
      requested.push([...ids]);
      observer = progress!;
      observer.setRetarget(retarget);
      const abort = () => {
        active--;
      };
      signal.addEventListener("abort", abort, { once: true });
      return new Promise((resolve) => {
        finish = () => {
          signal.removeEventListener("abort", abort);
          if (!signal.aborted) active--;
          resolve([]);
        };
      });
    },
  });
  for (const rank of [0, 1, 257, 513]) {
    const record = records[rank]!;
    const upcoming = () => records.slice(rank + 1).map((entry) => entry.id);
    expect(remote.read(record, upcoming)).toBe("pending");
    for (let retargetIndex = 0; retargetIndex < 12; retargetIndex++) remote.cancel(() => true);
    observer.onProgress([{ id: record.id, parts: [{ d: "M0 0Z", paint: "fill" }] }]);
    expect(remote.read(record, upcoming)).toEqual([{ d: "M0 0Z", paint: "fill" }]);
    finish();
    await Promise.resolve();
  }
  // Unreturned IDs retain their local-fallback slots instead of evicting valid overlap.
  expect(requested.map((ids) => ids.length)).toEqual([1, 256, 1, 1]);
  expect(Math.max(...requested.map((ids) => ids.length))).toBe(MAX_PREPARED_SCENE_PATH_IDS);
  expect(retarget).toHaveBeenCalledTimes(4);
  expect(active).toBe(0);
  const next = records[769]!;
  expect(remote.read(next, () => [])).toBe("pending");
  expect(active).toBe(1);
  remote.cancel();
  observer.onProgress([{ id: next.id, parts: [{ d: "M0 0Z", paint: "fill" }] }]);
  finish();
  await Promise.resolve();
  expect(active).toBe(0);
  expect(remote.waiting).toBe(false);
  expect(remote.memoryUsage()).toBe(0);
});
