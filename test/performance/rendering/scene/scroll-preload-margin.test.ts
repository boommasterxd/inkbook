import { beforeAll, expect, it, vi } from "vitest";
import { SCENE_PUBLICATION_ROOTS_PER_FRAME } from "../../../../src/rendering/scene/constants";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { visibilityPageBounds } from "../../../../src/rendering/scene/scene-resource-policy";
import { SceneVisibilityState } from "../../../../src/rendering/scene/visibility/visibility-state";
import { PAGE_WIDTH, boundsIntersect } from "../../../../src/domain/geometry/public";
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

it("finishes the latest fractional width-fit scroll fringe while the viewport keeps moving", () => {
  const domain = new ElementStore(elements);
  const store = new ElementSceneStore(domain);
  const state = new SceneVisibilityState(store, createInstrumentation());
  const viewport = { width: 360, height: 800, left: 0, top: 1_000 };
  const camera = { zoom: viewport.width / PAGE_WIDTH, x: 0 };
  const project = (top: number) => visibilityPageBounds({ ...viewport, top }, camera);
  const initial = project(viewport.top);
  const published = state.query(initial.envelope, initial.retained).visibility.content.ids;
  const { query, work } = observeIndexedSceneQueries(domain);
  const get = vi.spyOn(store, "get");
  const bounds = vi.spyOn(store, "getBounds");
  const now = () => work.indexedVisits + get.mock.calls.length + bounds.mock.calls.length;
  try {
    for (let step = 0; step < 120; step += 1) {
      const target = project(viewport.top + 110 + step);
      const result = state.query(target.envelope, target.retained, true, now() + 12, now);
      if (result.pending) {
        expect(result.visibility.content.ids).toBe(published);
        continue;
      }
      const expected = elements
        .filter(({ id }) => boundsIntersect(domain.get(id)!.bounds, target.envelope))
        .map(({ id }) => id);
      expect(result.visibility.content.ids).toEqual(expected);
      expect(result.delta?.entered.length).toBeGreaterThan(0);
      expect(result.delta?.exited.length).toBeGreaterThan(0);
      // Each edge travels under six grid rows, each containing at most 28 overlapping boxes.
      expect(query.mock.calls.length).toBeLessThanOrEqual(12);
      expect(work.indexedVisits).toBeLessThanOrEqual(700);
      expect(bounds.mock.calls.length).toBeGreaterThan(get.mock.calls.length);
      expect(new Set(bounds.mock.calls.map(([id]) => id)).size).toBe(bounds.mock.calls.length);
      expect(new Set(get.mock.calls.map(([id]) => id)).size).toBe(get.mock.calls.length);
      return;
    }
    throw new Error("Overlapping scroll targets exhausted every slice without publication.");
  } finally {
    bounds.mockRestore();
    get.mockRestore();
    query.mockRestore();
    state.release();
    store.release();
    expect(state.queryMemoryUsage()).toBe(0);
  }
});

it("visits only the touched cell when both scroll edges move within one dense row of the index", () => {
  const domain = new ElementStore(elements);
  const store = new ElementSceneStore(domain);
  const state = new SceneVisibilityState(store, createInstrumentation());
  const first = { minX: 0, maxX: 100, minY: 520, maxY: 535 };
  state.query(first);
  const { query, work } = observeIndexedSceneQueries(domain);
  const rank = vi.spyOn(domain, "getRank");
  try {
    const next = { ...first, minY: 525, maxY: 540 };
    const result = state.query(next);
    expect(result.delta?.entered).toEqual([elements[54]!.id]);
    expect(result.visibility.content.ids).toEqual(elements.slice(51, 55).map(({ id }) => id));
    // A 256-unit row has at most 28 intersecting boxes spaced ten units apart.
    expect(work.indexedVisits).toBeLessThanOrEqual(28 + 8);
    expect(rank.mock.calls).toEqual([[elements[54]!.id]]);
  } finally {
    rank.mockRestore();
    query.mockRestore();
    state.release();
    store.release();
  }
});

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
    const content = fakeNode(renderer.svg).nodes[1]!.nodes[5]!;
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
