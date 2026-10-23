import { beforeAll, expect, it, vi } from "vitest";
import { SCENE_PUBLICATION_ROOTS_PER_FRAME } from "../../../../src/rendering/scene/constants";
import { ElementStore } from "../../../../src/domain/store/public";
import { takeImmutableElementOwnership } from "../../../../src/domain/store/records/immutability";
import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import { createSceneFixture, observeIndexedSceneQueries } from "../../../fixtures/rendering/scene";
import { fakeNode, fakeRectangleRecord } from "../../../unit/rendering/scene/fakes";
import { uuid } from "../../../unit/domain/schema/fixtures";

let elements: readonly InkElementV1[];
beforeAll(() => {
  elements = Object.freeze(
    Array.from({ length: 10_000 }, (_, rank) => {
      const element = fakeRectangleRecord(uuid(rank + 1_000), rank, 20, rank * 10).element;
      takeImmutableElementOwnership(element);
      return element;
    }),
  );
});

function createIndexedMarginFixture(margin: number) {
  const domain = new ElementStore(elements);
  const store = new ElementSceneStore(domain);
  const { query, work } = observeIndexedSceneQueries(domain);
  const fixture = createSceneFixture(
    NAVIGATION_PAGE,
    store,
    { height: 100, left: 0, top: 1_000, width: 100 },
    { scrollPreloadMarginPx: margin },
  );
  fixture.renderer.setReducedMotion(true);
  const create = vi.spyOn(fixture.document, "createElementNS");
  return { ...fixture, create, query, store, visits: () => work.indexedVisits };
}

function drainBoundedPublication(fixture: ReturnType<typeof createIndexedMarginFixture>): void {
  let remaining = 100;
  while (fixture.scheduler.pendingCount > 0) {
    expect(remaining--).toBeGreaterThan(0);
    const before = fixture.renderer.instrumentation().domRootsPublished;
    fixture.scheduler.runNext();
    expect(fixture.renderer.instrumentation().domRootsPublished - before).toBeLessThanOrEqual(
      SCENE_PUBLICATION_ROOTS_PER_FRAME,
    );
  }
}

it.each([100, 300, 800])(
  "bounds actual indexed visits and roots for a %s-pixel margin within 10,000 rows",
  (margin) => {
    const fixture = createIndexedMarginFixture(margin);
    try {
      drainBoundedPublication(fixture);
      const count = (100 + margin * 2) / 10 + 3;
      expect(fixture.renderer.mountedCount).toBe(count);
      expect(fixture.renderer.instrumentation().geometryBuilds).toBe(count);
      expect(fixture.create.mock.calls.filter(([, tag]) => tag === "path")).toHaveLength(count);
      // Grid traversal and duplicated cell memberships add at most 128 boundary visits.
      expect(fixture.visits()).toBeLessThanOrEqual(count + 128);
      expect(fixture.query).toHaveBeenCalledOnce();
      const before = fixture.visits();
      fixture.renderer.setScrollPreloadMarginPx(margin);
      expect(fixture.scheduler.pendingCount).toBe(0);
      expect(fixture.visits()).toBe(before);
    } finally {
      fixture.renderer.destroy();
      fixture.store.release();
    }
    expect(fixture.scheduler.pendingCount).toBe(0);
    expect(fixture.renderer.instrumentation().pathCacheEntries).toBe(0);
  },
);

it("shrinks and refills only indexed fringes while retaining unchanged paths and cached roots", () => {
  const fixture = createIndexedMarginFixture(100);
  const { renderer } = fixture;
  try {
    drainBoundedPublication(fixture);
    const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
    const original = [...content.nodes];
    for (const margin of [300, 800]) {
      renderer.setScrollPreloadMarginPx(margin);
      drainBoundedPublication(fixture);
      expect(renderer.mountedCount).toBe((100 + margin * 2) / 10 + 3);
      expect(original.every((node) => content.nodes.includes(node))).toBe(true);
    }
    const builds = renderer.instrumentation().geometryBuilds;
    const paths = fixture.create.mock.calls.filter(([, tag]) => tag === "path").length;
    const retained = [...content.nodes];
    renderer.setScrollPreloadMarginPx(100);
    drainBoundedPublication(fixture);
    expect(renderer.mountedCount).toBe(33);
    expect(renderer.instrumentation().geometryBuilds).toBe(builds);
    renderer.setScrollPreloadMarginPx(800);
    drainBoundedPublication(fixture);
    expect(renderer.mountedCount).toBe(173);
    expect(renderer.instrumentation().geometryBuilds).toBe(builds);
    expect(fixture.create.mock.calls.filter(([, tag]) => tag === "path")).toHaveLength(paths);
    expect(content.nodes).toEqual(retained);
    // Initial query and four fringe transitions stay far below a document scan.
    expect(fixture.visits()).toBeLessThanOrEqual(1_024);
    expect(renderer.instrumentation().detachedCacheEntries).toBe(0);
  } finally {
    renderer.destroy();
    fixture.store.release();
  }
  expect(fixture.scheduler.pendingCount).toBe(0);
  expect(renderer.instrumentation().detachedCacheBytes).toBe(0);
});
