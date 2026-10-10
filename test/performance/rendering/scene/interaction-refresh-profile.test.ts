import { describe, expect, it, vi } from "vitest";

import { SvgSceneRenderer } from "../../../../src/rendering/scene";
import {
  DETACHED_ELEMENT_CACHE_MAX_BYTES,
  PATH_CACHE_MAX_BYTES,
} from "../../../../src/rendering/scene/constants";
import { ScenePathCache } from "../../../../src/rendering/scene/path-cache";
import {
  FakeScheduler,
  FakeNode,
  FakeSceneStore,
  fakeNode,
} from "../../../unit/rendering/scene/fakes";
import {
  createPressureNavigationHarness,
  NAVIGATION_VISIBLE_STROKES,
  NAVIGATION_PAGE,
} from "../../../fixtures/rendering/pressure-navigation";
import { createSceneFixture, flushSceneViewport } from "../../../fixtures/rendering/scene";
import { INTERACTION_REFRESH_PROFILE } from "../../interaction-refresh-profile";
import {
  INTERACTION_ELEMENT_COUNT,
  createInteractionFixture,
  createInteractionRenderer,
} from "./interaction-refresh-profile-fixture";

const PREVIEW_FRAMES = 12;

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz interaction profile`, () => {
  it("retains geometry through camera and selection preview updates", () => {
    const fixture = createInteractionFixture();
    const { renderer, scheduler } = createInteractionRenderer(fixture.store);
    scheduler.runAll();
    renderer.resetInstrumentation();
    const mounted = new Set(renderer.mountedIds("content"));
    const preparations = vi.spyOn(ScenePathCache.prototype, "startPreparation");

    runCameraFrames(renderer, scheduler);
    const cameraStats = renderer.instrumentation();
    expect(cameraStats.spatialQueries).toBe(0);
    expect(cameraStats.visibilityHysteresisHits).toBe(PREVIEW_FRAMES);
    expect(cameraStats).toMatchObject({ domEntrants: 0, domExits: 0 });
    // The rightward strip covers at most 14 ten-unit columns and 39 nonnegative rows.
    // Local preparation may finish this indexed region without a transport-ID CPU quota.
    expect(cameraStats.geometryBuilds).toBeLessThanOrEqual(14 * 39);
    expect(preparations.mock.calls.length).toBe(cameraStats.geometryBuilds);
    expect(new Set(preparations.mock.calls.map(([element]) => element.id)).size).toBe(
      preparations.mock.calls.length,
    );
    expect(preparations.mock.calls.every(([element]) => !mounted.has(element.id))).toBe(true);
    preparations.mockRestore();

    renderer.setPreviewTransform(fixture.ids, "translate(0 0)", 1);
    scheduler.runAll();
    renderer.resetInstrumentation();
    runSelectionFrames(renderer, scheduler, fixture.ids);
    expect(renderer.instrumentation()).toMatchObject({
      domEntrants: 0,
      domExits: 0,
      geometryBuilds: 0,
    });
    expect(renderer.mountedCount).toBeLessThan(INTERACTION_ELEMENT_COUNT);
    renderer.destroy();
  });
});

function runCameraFrames(renderer: SvgSceneRenderer, scheduler: FakeScheduler): void {
  for (let frame = 0; frame < PREVIEW_FRAMES; frame += 1) {
    renderer.setCamera({ x: -10 + Math.sin(frame / 30) * 10, zoom: 1 });
    expect(scheduler.pendingCount).toBe(1);
    scheduler.runAll();
  }
}

function runSelectionFrames(
  renderer: SvgSceneRenderer,
  scheduler: FakeScheduler,
  ids: readonly string[],
): void {
  for (let frame = 0; frame < PREVIEW_FRAMES; frame += 1) {
    renderer.setPreviewTransform(ids, `translate(${String(frame / 10)} 0)`, frame + 2);
    expect(scheduler.pendingCount).toBe(1);
    scheduler.runAll();
  }
}

it("finishes cold pressure mounting during uninterrupted zoom and reuses dense offscreen paths", () => {
  const { document, renderer, scheduler } = createPressureNavigationHarness();
  const nodes = vi.spyOn(document, "createElementNS");
  let frame = 0;
  for (; frame < INTERACTION_REFRESH_PROFILE.sampleCount; frame += 1) {
    renderer.setCamera({ x: Math.sin(frame / 4), zoom: 1 + (frame % 20) / 1_000 });
    scheduler.time = frame * INTERACTION_REFRESH_PROFILE.frameDurationMs;
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
  expect(nodes.mock.calls.filter(([, tag]) => tag === "g")).toHaveLength(recreated);
  renderer.destroy();
  expect(renderer.instrumentation().pathCacheEntries).toBe(0);
  expect(scheduler.pendingCount).toBe(0);
});

it("makes entrant progress while every camera frame changes membership under a busy deadline", () => {
  const { document, renderer, scheduler, store } = createPressureNavigationHarness();
  scheduler.runAll();
  expect(renderer.mountedCount).toBe(NAVIGATION_VISIBLE_STROKES);
  renderer.resetInstrumentation();
  const nodes = vi.spyOn(document, "createElementNS");
  const now = vi.spyOn(scheduler, "now").mockImplementation(() => {
    scheduler.time += 0.5;
    return scheduler.time;
  });
  const persistentId = [...store.records.keys()][NAVIGATION_VISIBLE_STROKES]!;
  for (let frame = 0; frame < INTERACTION_REFRESH_PROFILE.sampleCount; frame += 1) {
    scheduler.time = frame * INTERACTION_REFRESH_PROFILE.frameDurationMs;
    renderer.setCamera({ x: frame % 2 === 0 ? -50 : -100, zoom: 1 });
    scheduler.runNext();
    if (renderer.mountedIds("content").includes(persistentId)) break;
  }
  expect(renderer.mountedIds("content")).toContain(persistentId);
  // Only the two entering strokes may allocate paths; retained ink is never rebuilt.
  expect(nodes.mock.calls.filter(([, tag]) => tag === "path").length).toBeLessThanOrEqual(2);
  // Two entrants plus at most one cancelled build of the alternating entrant.
  expect(renderer.instrumentation().geometryBuilds).toBeLessThanOrEqual(3);
  expect(renderer.instrumentation().visibilityHysteresisHits).toBeLessThanOrEqual(
    INTERACTION_REFRESH_PROFILE.sampleCount,
  );
  now.mockRestore();
  renderer.setCamera({ x: -50, zoom: 1 });
  scheduler.runAll();
  expect(renderer.mountedCount).toBe(NAVIGATION_VISIBLE_STROKES + 1);
  renderer.destroy();
  expect(scheduler.pendingCount).toBe(0);
});

it("completes initial mounting through subpixel host layout changes without repeated geometry", () => {
  const viewport = { height: 100, left: 0, top: 0, width: 100 };
  const { renderer, scheduler, document } = createPressureNavigationHarness(viewport);
  const nodes = vi.spyOn(document, "createElementNS");
  for (let frame = 0; frame < INTERACTION_REFRESH_PROFILE.sampleCount; frame += 1) {
    viewport.height = 100 + (frame % 2) / 100;
    scheduler.time = frame * INTERACTION_REFRESH_PROFILE.frameDurationMs;
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
    const { renderer, scheduler } = createSceneFixture(page, new FakeSceneStore(), undefined, {
      frameBudgetMs: () => INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs,
    });
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
