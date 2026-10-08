import { expect, it, vi } from "vitest";
import type { SceneCamera, SceneViewport } from "../../../../src/rendering/scene/types";
import type { SvgSceneRenderer } from "../../../../src/rendering/scene";
import { ScenePathCache } from "../../../../src/rendering/scene/path-cache";
import { DetachedSceneElementCache } from "../../../../src/rendering/scene/detached-element-cache";
import { visibilityPageBounds } from "../../../../src/rendering/scene/scene-resource-policy";
import { intersects } from "../../../../src/rendering/scene/visibility-bounds";
import {
  DETACHED_ELEMENT_CACHE_MAX_BYTES,
  PATH_CACHE_MAX_BYTES,
  SCENE_PUBLICATION_ROOTS_PER_FRAME,
} from "../../../../src/rendering/scene/constants";
import {
  createSceneFixture,
  createSceneRecord,
  createIndexedSceneStore,
} from "../../../fixtures/rendering/scene";
import {
  collectFrameWrites,
  expectReleasedPublicationScene,
} from "../../../fixtures/rendering/scene-publication";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { FakeSceneStore, fakeNode } from "../../../unit/rendering/scene/fakes";

function createZoomRecords(): FakeSceneStore {
  const records = new FakeSceneStore();
  for (let rank = 0; rank < 10_000; rank += 1) {
    const crossing = rank === 9_999;
    const x = crossing ? -100 : (rank % 100) * 8;
    const y = crossing ? 1_200 : Math.floor(rank / 100) * 20;
    const base = indexedStroke(rank);
    records.records.set(
      base.id,
      createSceneRecord(
        {
          ...base,
          pivot: { x, y },
          points: [x, y, 0.5, crossing ? 900 : x + 3, y + 3, 0.5],
          style: { ...base.style, pressureEnabled: false },
        },
        rank,
      ),
    );
  }
  return records;
}

function observeCacheSnapshots(renderer: SvgSceneRenderer) {
  const path = vi.spyOn(ScenePathCache.prototype, "statistics");
  const detached = vi.spyOn(DetachedSceneElementCache.prototype, "statistics");
  return {
    read() {
      // Settled camera/content frames and reset must not materialize debug snapshots.
      expect(path).not.toHaveBeenCalled();
      expect(detached).not.toHaveBeenCalled();
      const snapshot = renderer.instrumentation();
      expect(path).toHaveBeenCalledOnce();
      expect(detached).toHaveBeenCalledOnce();
      const pathStats = path.mock.results[0]!.value as ReturnType<ScenePathCache["statistics"]>;
      const detachedStats = detached.mock.results[0]!.value as ReturnType<
        DetachedSceneElementCache["statistics"]
      >;
      expect(snapshot).toMatchObject({
        geometryBuilds: pathStats.builds,
        pathCacheBytes: pathStats.bytes,
        pathCacheEntries: pathStats.entries,
        pathCacheEvictions: pathStats.evictions,
        pathCacheHits: pathStats.hits,
        detachedCacheBytes: detachedStats.bytes,
        detachedCacheEntries: detachedStats.entries,
        detachedCacheEvictions: detachedStats.evictions,
        detachedCacheHits: detachedStats.hits,
      });
      expect(snapshot.pathCacheBytes).toBeLessThanOrEqual(PATH_CACHE_MAX_BYTES);
      expect(snapshot.detachedCacheBytes).toBeLessThanOrEqual(DETACHED_ELEMENT_CACHE_MAX_BYTES);
      path.mockClear();
      detached.mockClear();
      return snapshot;
    },
    resetAndRead() {
      const before = this.read();
      renderer.resetInstrumentation();
      expect(this.read()).toMatchObject({
        pathCacheBytes: before.pathCacheBytes,
        pathCacheEntries: before.pathCacheEntries,
        detachedCacheBytes: before.detachedCacheBytes,
        detachedCacheEntries: before.detachedCacheEntries,
        geometryBuilds: 0,
        pathCacheHits: 0,
        pathCacheEvictions: 0,
        detachedCacheHits: 0,
        detachedCacheEvictions: 0,
      });
      return before;
    },
    restore() {
      path.mockRestore();
      detached.mockRestore();
    },
  };
}

it.each([false, true])(
  "revisits horizontal and vertical zoom fringes through the real index (reversal=%s)",
  (reversal) => {
    const records = createZoomRecords();
    const { store, work, fallback } = createIndexedSceneStore(records);
    const viewport = { left: 0, top: 1_000, width: 800, height: 400 };
    const { renderer, scheduler, document } = createSceneFixture(NAVIGATION_PAGE, store, viewport, {
      isInputActive: () => true,
    });
    renderer.setReducedMotion(true);
    scheduler.runAll(200);
    const initial = renderer.mountedIds("content");
    const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
    const crossingNode = content.nodes[initial.indexOf(indexedStroke(9_999).id)]!;
    const crossingPath = crossingNode.attributes.get("d");
    const crossingElement = records.get(indexedStroke(9_999).id)!.element;
    const create = vi.spyOn(document, "createElementNS");
    const scans = vi.spyOn(records.records, "values");
    const snapshots = observeCacheSnapshots(renderer);
    const expected = (camera: SceneCamera, clip: SceneViewport) => {
      const bounds = visibilityPageBounds(clip, camera).envelope;
      return [...records.records.entries()]
        .filter(([, record]) => intersects(record.bounds, bounds))
        .map(([id]) => id);
    };
    const change = (camera: SceneCamera, clip: SceneViewport) => {
      renderer.setViewport(clip);
      renderer.setCamera(camera);
    };
    renderer.resetInstrumentation();
    work.indexedVisits = 0;
    try {
      expect(crossingPath).toBeTruthy();
      const zoomed = { ...viewport, top: 4_600 };
      const camera = { x: -300, zoom: 4 };
      const writes = collectFrameWrites(content, scheduler, () => change(camera, zoomed), 200);
      expect(writes.every((roots) => roots <= SCENE_PUBLICATION_ROOTS_PER_FRAME)).toBe(true);
      expect(renderer.mountedIds("content")).toEqual(expected(camera, zoomed));
      expect(renderer.mountedCount).toBeLessThan(initial.length);
      const beforePan = snapshots.read();
      expect(beforePan.detachedCacheEvictions).toBeGreaterThan(0);
      expect(crossingNode.parent).toBe(content);
      expect(crossingNode.attributes.get("d")).toBe(crossingPath);
      expect(records.get(indexedStroke(9_999).id)!.element).toBe(crossingElement);
      expect(beforePan.geometryBuilds).toBe(0);
      const beforePanVisits = work.indexedVisits;
      change({ x: -302, zoom: 4 }, { ...zoomed, top: 4_610 });
      scheduler.runAll();
      const afterPan = snapshots.read();
      expect(afterPan.domEntrants).toBe(beforePan.domEntrants);
      expect(afterPan.domExits).toBe(beforePan.domExits);
      expect(work.indexedVisits).toBe(beforePanVisits);
      if (reversal) {
        change({ x: 0, zoom: 1 }, viewport);
        scheduler.runNext();
        change(camera, zoomed);
        scheduler.runNext();
      }
      const returnWrites = collectFrameWrites(
        content,
        scheduler,
        () => change({ x: 0, zoom: 1 }, viewport),
        200,
      );
      expect(returnWrites.every((roots) => roots <= SCENE_PUBLICATION_ROOTS_PER_FRAME)).toBe(true);
      expect(renderer.mountedIds("content")).toEqual(initial);
      expect(content.nodes).toHaveLength(initial.length);
      expect(crossingNode.parent).toBe(content);
      expect(crossingNode.attributes.get("d")).toBe(crossingPath);
      expect(snapshots.resetAndRead().geometryBuilds).toBe(0);
      expect(create.mock.calls.filter(([, tag]) => tag === "path").length).toBeLessThanOrEqual(
        initial.length * (reversal ? 2 : 1),
      );
      // Two envelope transitions query at most eight indexed fringes each. Their
      // coarse cells may revisit a candidate; this bound includes those real visits.
      expect(work.indexedVisits).toBeLessThanOrEqual(initial.length * 8 * (reversal ? 2 : 1));
      expect(fallback).not.toHaveBeenCalled();
      expect(scans).not.toHaveBeenCalled();
      renderer.setCamera({ x: -1_000, zoom: 4 });
    } finally {
      scans.mockRestore();
      create.mockRestore();
      renderer.destroy();
      try {
        expect(snapshots.read()).toMatchObject({ pathCacheBytes: 0, detachedCacheBytes: 0 });
      } finally {
        snapshots.restore();
      }
    }
    expectReleasedPublicationScene(renderer, scheduler);
  },
);
