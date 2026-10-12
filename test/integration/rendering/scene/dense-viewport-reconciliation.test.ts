import { describe, expect, it } from "vitest";

import { HitTestScratch } from "../../../../src/editor/selection/hit-test";
import { SvgSceneRenderer } from "../../../../src/rendering/scene";
import { fakeNode } from "../../../unit/rendering/scene/fakes";
import {
  DENSE_VIEWPORT_PROFILES,
  createDenseViewportFixture,
  createDenseViewportHarness,
} from "./dense-viewport-fixture";

describe("dense viewport reconciliation acceptance", () => {
  for (const profile of DENSE_VIEWPORT_PROFILES) {
    it(`reconciles the exact ${profile.name} fixture with progressive ordered publication`, () => {
      const fixture = createDenseViewportFixture();
      const { renderer, scheduler, store } = createDenseViewportHarness({
        fixture,
        reverseInsertion: true,
        viewport: profile.viewport,
      });

      expect(
        fixture.records.every(({ bounds }) =>
          intersectsViewport(bounds, profile.viewport[0], profile.viewport[1]),
        ),
      ).toBe(true);

      scheduler.runNext();
      const initial = new Set(renderer.mountedIds("content"));
      const promoted = fixture.contentIds.find((id) => !initial.has(id))!;
      expect(promoted).toBeDefined();
      expect(renderer.mountedIds("content")).not.toContain(promoted);
      renderer.promoteVisible(promoted);
      scheduler.runNext();
      expect(renderer.mountedIds("content")).toContain(promoted);
      scheduler.runAll();

      const measurements = renderer.instrumentation();
      expect(measurements.domFragmentRuns).toBeGreaterThan(2);
      expect(measurements).toMatchObject({
        domEntrants: 2_500,
        spatialQueries: 1,
      });
      expect(measurements.collectionAllocations).toBeGreaterThan(0);
      expect(measurements.geometryBuilds).toBe(2_500);
      expect(measurements.maximumMountSliceElements).toBeGreaterThan(0);
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
        visibilityCandidateCacheHits: 0,
        visibilityHysteresisHits: 1,
      });
      expect(store.queryCount).toBe(1);
      renderer.destroy();
    });
  }

  it("resolves all 100 versioned hit points to their unique fixture paths", () => {
    const fixture = createDenseViewportFixture();
    const candidates = fixture.records.map(({ band, element, rank }) => ({ band, element, rank }));
    const scratch = new HitTestScratch();
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
      scratch.begin(hit.point, "pen", 1);
      for (const candidate of candidates) {
        scratch.consider(candidate.element.id, candidate.band, candidate.element, candidate.rank);
      }
      expect(scratch.finish()).toBe(hit.expectedId);
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
  const renderedIds = [camera.nodes[3]!, camera.nodes[4]!].flatMap(({ nodes }) =>
    nodes.map((node) =>
      idByPath.get((node.tagName === "g" ? node.nodes[0]! : node).attributes.get("d") ?? ""),
    ),
  );
  expect(renderer.mountedIds("highlight")).toEqual(highlightIds);
  expect(renderer.mountedIds("content")).toEqual(contentIds);
  expect(renderedIds).toEqual(expectedIds);
  expect(new Set(renderedIds)).toHaveLength(2_500);
}
