import { afterEach, beforeAll, expect, it, vi } from "vitest";

import { SpatialQueryCursor } from "../../../../src/domain/spatial/query-cursor";
import {
  DETACHED_ELEMENT_CACHE_MAX_BYTES,
  PATH_CACHE_MAX_BYTES,
} from "../../../../src/rendering/scene/constants";
import {
  FakeScheduler,
  FakeNode,
  FakeSceneStore,
  fakeNode,
} from "../../../unit/rendering/scene/fakes";
import {
  createPressureNavigationHarness,
  createPressureNavigationRecords,
  NAVIGATION_VISIBLE_STROKES,
  NAVIGATION_PAGE,
} from "../../../fixtures/rendering/pressure-navigation";
import { createSceneFixture, flushSceneViewport } from "../../../fixtures/rendering/scene";
import { observePathPreparationSteps } from "../../../fixtures/rendering/path-preparation-work";
import { INTERACTION_REFRESH_PROFILE } from "../../interaction-refresh-profile";

// Actual store/path work spends the simulated slice; reading its clock does not.
const SIMULATED_WORK_COST_MS = 0.5;
let pressureRecords: ReturnType<typeof createPressureNavigationRecords>;
beforeAll(() => {
  pressureRecords = createPressureNavigationRecords();
});
afterEach(() => vi.restoreAllMocks());

class ProfileScheduler extends FakeScheduler {
  public constructor() {
    super(INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs);
  }

  public override runNext(): void {
    this.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
    super.runNext();
  }
}

it("finishes cold pressure mounting during uninterrupted zoom and reuses dense offscreen paths", () => {
  const { document, renderer, scheduler } = createPressureNavigationHarness(
    undefined,
    pressureRecords,
    new ProfileScheduler(),
  );
  const nodes = vi.spyOn(document, "createElementNS");
  let frame = 0;
  for (; frame < INTERACTION_REFRESH_PROFILE.sampleCount; frame += 1) {
    renderer.setCamera({ x: Math.sin(frame / 4), zoom: 1 + (frame % 20) / 1_000 });
    scheduler.runNext();
    if (renderer.mountedCount === NAVIGATION_VISIBLE_STROKES) break;
  }
  expect(renderer.mountedCount).toBe(NAVIGATION_VISIBLE_STROKES);
  expect(renderer.instrumentation()).toMatchObject({
    domEntrants: NAVIGATION_VISIBLE_STROKES,
    geometryBuilds: NAVIGATION_VISIBLE_STROKES,
  });
  expect(nodes.mock.calls.filter(([, tag]) => tag === "path")).toHaveLength(
    NAVIGATION_VISIBLE_STROKES,
  );
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  const original = new Set(content.nodes);

  flushSceneViewport(renderer, scheduler, { height: 100, left: 0, top: 10_000, width: 100 });
  expect(renderer.instrumentation().pathCacheEntries).toBe(NAVIGATION_VISIBLE_STROKES);
  expect(renderer.instrumentation().pathCacheBytes).toBeLessThanOrEqual(PATH_CACHE_MAX_BYTES);
  expect(content.nodes).toHaveLength(0);
  expect([...original].every((node) => node.parent === undefined)).toBe(true);
  const retainedNodes = renderer.instrumentation().detachedCacheEntries;
  expect(retainedNodes).toBeGreaterThan(0);
  expect(retainedNodes).toBeLessThan(NAVIGATION_VISIBLE_STROKES);
  expect(renderer.instrumentation().detachedCacheBytes).toBeLessThanOrEqual(
    DETACHED_ELEMENT_CACHE_MAX_BYTES,
  );
  const recreated = NAVIGATION_VISIBLE_STROKES - retainedNodes;
  renderer.resetInstrumentation();
  nodes.mockClear();
  flushSceneViewport(renderer, scheduler, { height: 100, left: 0, top: 0, width: 100 });
  expect(renderer.instrumentation()).toMatchObject({
    geometryBuilds: 0,
    detachedCacheHits: retainedNodes,
    contentGeometryWrites: recreated,
    domRootsPublished: NAVIGATION_VISIBLE_STROKES,
  });
  expect(content.nodes).toHaveLength(NAVIGATION_VISIBLE_STROKES);
  expect(content.nodes.filter((node) => original.has(node))).toHaveLength(retainedNodes);
  expect(nodes.mock.calls.filter(([, tag]) => tag === "path")).toHaveLength(recreated);
  expect(nodes.mock.calls.filter(([, tag]) => tag === "g")).toHaveLength(0);
  renderer.destroy();
  expect(renderer.instrumentation().pathCacheEntries).toBe(0);
  expect(scheduler.pendingCount).toBe(0);
});

it("makes entrant progress while every camera frame changes membership under a busy deadline", () => {
  const { document, renderer, scheduler, store } = createPressureNavigationHarness(
    undefined,
    pressureRecords,
    new ProfileScheduler(),
    "indexed",
  );
  scheduler.runAll();
  expect(renderer.mountedCount).toBe(NAVIGATION_VISIBLE_STROKES);
  renderer.resetInstrumentation();
  const nodes = vi.spyOn(document, "createElementNS");
  const get = store.get.bind(store);
  const read = vi.spyOn(store, "get").mockImplementation((id) => {
    const record = get(id);
    scheduler.time += SIMULATED_WORK_COST_MS;
    return record;
  });
  const originalAdvance = Object.getOwnPropertyDescriptor(SpatialQueryCursor.prototype, "advance")!
    .value as SpatialQueryCursor<unknown>["advance"];
  const cursors = new Set<SpatialQueryCursor<unknown>>();
  let indexedVisits = 0;
  const advance = vi.spyOn(SpatialQueryCursor.prototype, "advance").mockImplementation(function (
    this: SpatialQueryCursor<unknown>,
    maximum,
  ) {
    cursors.add(this);
    const result = originalAdvance.call(this, maximum);
    indexedVisits += result.workUnits;
    scheduler.time += result.workUnits * SIMULATED_WORK_COST_MS;
    return result;
  });
  const step = observePathPreparationSteps(() => {
    scheduler.time += SIMULATED_WORK_COST_MS;
  });
  try {
    const persistentId = [...store.records.keys()][NAVIGATION_VISIBLE_STROKES]!;
    const visitsPerFrame = Math.ceil(
      INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs / SIMULATED_WORK_COST_MS,
    );
    let deadlineFrames = 0;
    for (let frame = 0; frame < INTERACTION_REFRESH_PROFILE.sampleCount; frame += 1) {
      renderer.setCamera({ x: frame % 2 === 0 ? -50 : -100, zoom: 1 });
      const beforeVisits = indexedVisits;
      const frameStart = scheduler.time + INTERACTION_REFRESH_PROFILE.frameDurationMs;
      scheduler.runNext();
      expect(indexedVisits - beforeVisits).toBeLessThanOrEqual(visitsPerFrame);
      if (scheduler.time >= frameStart + INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs)
        deadlineFrames += 1;
      if (renderer.mountedIds("content").includes(persistentId)) break;
    }
    expect(indexedVisits).toBeLessThanOrEqual(
      INTERACTION_REFRESH_PROFILE.sampleCount * visitsPerFrame,
    );
    expect(deadlineFrames).toBeGreaterThan(0);
    expect(
      renderer.mountedIds("content"),
      JSON.stringify({
        indexedVisits,
        cursors: cursors.size,
        preparations: step.mock.calls.length,
      }),
    ).toContain(persistentId);
    expect(step).toHaveBeenCalled();
    // Only the two entering strokes may allocate paths; retained ink is never rebuilt.
    expect(nodes.mock.calls.filter(([, tag]) => tag === "path").length).toBeLessThanOrEqual(2);
    // Two entrants plus at most one cancelled build of the alternating entrant.
    expect(renderer.instrumentation().geometryBuilds).toBeLessThanOrEqual(3);
    expect(renderer.instrumentation().visibilityHysteresisHits).toBeLessThanOrEqual(
      INTERACTION_REFRESH_PROFILE.sampleCount,
    );
    step.mockRestore();
    read.mockRestore();
    advance.mockRestore();
    renderer.setCamera({ x: -50, zoom: 1 });
    scheduler.runAll();
    expect(renderer.mountedCount).toBe(NAVIGATION_VISIBLE_STROKES + 1);
  } finally {
    renderer.destroy();
    expect(scheduler.pendingCount).toBe(0);
    expect([...cursors].every((cursor) => cursor.memoryUsage() === 0)).toBe(true);
  }
});

it("completes initial mounting through subpixel host layout changes without repeated geometry", () => {
  const viewport = { height: 100, left: 0, top: 0, width: 100 };
  const { renderer, scheduler, document } = createPressureNavigationHarness(
    viewport,
    pressureRecords,
    new ProfileScheduler(),
  );
  const nodes = vi.spyOn(document, "createElementNS");
  for (let frame = 0; frame < INTERACTION_REFRESH_PROFILE.sampleCount; frame += 1) {
    viewport.height = 100 + (frame % 2) / 100;
    renderer.invalidateLayout(true);
    scheduler.runNext();
    if (!renderer.hasPendingSceneCommit) break;
  }
  expect(renderer.hasPendingSceneCommit).toBe(false);
  expect(renderer.mountedCount).toBe(NAVIGATION_VISIBLE_STROKES);
  expect(renderer.instrumentation()).toMatchObject({
    geometryBuilds: NAVIGATION_VISIBLE_STROKES,
    pathCacheHits: 0,
    domEntrants: NAVIGATION_VISIBLE_STROKES,
  });
  expect(nodes.mock.calls.filter(([, tag]) => tag === "path")).toHaveLength(
    NAVIGATION_VISIBLE_STROKES,
  );
  renderer.destroy();
  expect(scheduler.pendingCount).toBe(0);
});

it.each([0, 12, 40])(
  "completes bounded background work after a %s ms late frame callback",
  (delay) => {
    const page = {
      ...NAVIGATION_PAGE,
      background: { type: "dots" as const, spacing: 25 as const },
    };
    const { renderer, scheduler } = createSceneFixture(
      page,
      new FakeSceneStore(),
      undefined,
      {},
      new ProfileScheduler(),
    );
    const writes = vi.spyOn(FakeNode.prototype, "setAttribute");
    const now = vi.spyOn(scheduler, "now").mockImplementation(() => scheduler.time + delay);
    renderer.setPage(page, 1_000_000);
    scheduler.runNext();
    expect(renderer.hasPendingSceneCommit).toBe(false);
    expect(scheduler.pendingCount).toBe(0);
    expect(renderer.instrumentation()).toMatchObject({
      frames: 1,
      backgroundBuilds: 1,
      backgroundBudgetDeferrals: 0,
      geometryBuilds: 0,
      spatialQueries: 1,
    });
    // One camera write and a fixed background/palette update, independent of page height.
    expect(writes.mock.calls.length).toBeLessThanOrEqual(32);
    now.mockRestore();
    writes.mockRestore();
    renderer.destroy();
  },
);
