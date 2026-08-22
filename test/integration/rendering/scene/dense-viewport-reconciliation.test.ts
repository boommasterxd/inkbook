import { describe, expect, it } from "vitest";

import { findFrontmostHit } from "../../../../src/editor/selection/public";
import { SvgSceneRenderer } from "../../../../src/rendering/scene";
import {
  MOUNT_SLICE_GEOMETRY_COST_BUDGET,
  MOUNT_SLICE_STROKE_POINT_BUDGET,
} from "../../../../src/rendering/scene/constants";
import { fakeNode } from "../../../unit/rendering/scene/fakes";
import {
  DENSE_VIEWPORT_PROFILES,
  createDenseViewportFixture,
  createDenseViewportHarness,
} from "./dense-viewport-fixture";

describe("dense viewport reconciliation acceptance", () => {
  for (const profile of DENSE_VIEWPORT_PROFILES) {
    it(`reconciles the exact ${profile.name} fixture within both submitted deadlines`, () => {
      const fixture = createDenseViewportFixture();
      const { renderer, scheduler, store } = createDenseViewportHarness({
        fixture,
        reverseInsertion: true,
        viewport: profile.viewport,
      });
      const promoted = fixture.hits[99]!.expectedId;

      expect(
        fixture.records.every(({ bounds }) =>
          intersectsViewport(bounds, profile.viewport[0], profile.viewport[1]),
        ),
      ).toBe(true);

      scheduler.runNext();
      expect(renderer.mountedIds("content")).not.toContain(promoted);
      renderer.promoteVisible(promoted);
      scheduler.runNext();
      expect(renderer.mountedIds("content")).toContain(promoted);
      scheduler.runAll(profile.frameLimit);

      const measurements = renderer.instrumentation();
      const submittedElapsedMs = measurements.frames * (1_000 / 60);
      expect(measurements.frames).toBeLessThanOrEqual(profile.frameLimit);
      expect(submittedElapsedMs).toBeLessThanOrEqual(profile.elapsedLimitMs);
      expect(measurements).toMatchObject({
        domEntrants: 2_500,
        spatialQueries: 1,
      });
      expect(measurements.collectionAllocations).toBeGreaterThan(0);
      expect(measurements.maximumMountSliceStrokePoints).toBeLessThanOrEqual(
        MOUNT_SLICE_STROKE_POINT_BUDGET,
      );
      expect(measurements.maximumMountSliceStrokePoints).toBeGreaterThan(0);
      expect(measurements.maximumMountSliceGeometryCost).toBeLessThanOrEqual(
        MOUNT_SLICE_GEOMETRY_COST_BUDGET,
      );
      expectExactOrder(
        renderer,
        fixture.highlightIds,
        fixture.contentIds,
        fixture.expectedIds,
        fixture.idByPath,
      );

      renderer.resetInstrumentation();
      renderer.setCamera({ x: -0.25, zoom: 1 });
      scheduler.runAll();
      expect(renderer.instrumentation()).toMatchObject({
        collectionAllocations: 0,
        spatialQueries: 0,
        visibilityCandidateCacheHits: 1,
      });
      expect(store.queryCount).toBe(1);
      renderer.destroy();
    });
  }

  it("resolves all 100 versioned hit points to their unique fixture paths", () => {
    const fixture = createDenseViewportFixture();
    const candidates = fixture.records.map(({ band, element, rank }) => ({ band, element, rank }));
    const rankCounts = new Map<string, number>();
    for (const record of fixture.records) {
      const key = `${record.band}:${String(record.rank)}`;
      rankCounts.set(key, (rankCounts.get(key) ?? 0) + 1);
    }

    expect(fixture.hits).toHaveLength(100);
    expect(fixture.highlightIds).toHaveLength(1_250);
    expect(fixture.contentIds).toHaveLength(1_250);
    expect(new Set(fixture.expectedIds)).toHaveLength(2_500);
    expect([...rankCounts.values()].every((count) => count === 2)).toBe(true);
    for (const hit of fixture.hits) {
      expect(findFrontmostHit(hit.point, "pen", 1, candidates)).toBe(hit.expectedId);
    }
  });
});

describe("dense viewport resource policy", () => {
  it("disables entrant animation and removal tombstones while dense mode remains active", () => {
    const fixture = createDenseViewportFixture();
    const { renderer, scheduler, store } = createDenseViewportHarness({
      fixture,
      viewport: DENSE_VIEWPORT_PROFILES[0].viewport,
    });
    scheduler.runAll();
    renderer.resetInstrumentation();
    const source = fixture.records[0]!;
    const addedId = "dense-viewport-added";
    const added = {
      ...source,
      element: { ...source.element, id: addedId },
      id: addedId,
      rank: -1,
    };
    store.records.set(addedId, added);
    renderer.applyDelta({
      affected: [{ after: added.element, before: null, domains: ["visibility"], id: addedId }],
    });
    scheduler.runAll();

    const removed = fixture.records[1]!;
    store.records.delete(removed.id);
    renderer.applyDelta({
      affected: [
        {
          after: null,
          before: removed.element,
          domains: ["visibility"],
          id: removed.id,
        },
      ],
    });
    scheduler.runAll();

    expect(renderer.instrumentation()).toMatchObject({
      motionCacheEntries: 0,
      motionEntrances: 0,
      motionTombstones: 0,
      pathCacheEntries: 0,
    });
  });
});

function intersectsViewport(
  bounds: {
    readonly maxX: number;
    readonly maxY: number;
    readonly minX: number;
    readonly minY: number;
  },
  width: number,
  height: number,
): boolean {
  return bounds.minX <= width && bounds.maxX >= 0 && bounds.minY <= height && bounds.maxY >= 0;
}

function expectExactOrder(
  renderer: SvgSceneRenderer,
  highlightIds: readonly string[],
  contentIds: readonly string[],
  expectedIds: readonly string[],
  idByPath: ReadonlyMap<string, string>,
): void {
  const camera = fakeNode(renderer.svg).nodes[1]!;
  const renderedIds = [camera.nodes[2]!, camera.nodes[3]!].flatMap(({ nodes }) =>
    nodes.map(({ attributes }) => idByPath.get(attributes.get("d") ?? "")),
  );
  expect(renderer.mountedIds("highlight")).toEqual(highlightIds);
  expect(renderer.mountedIds("content")).toEqual(contentIds);
  expect(renderedIds).toEqual(expectedIds);
  expect(new Set(renderedIds)).toHaveLength(2_500);
}
