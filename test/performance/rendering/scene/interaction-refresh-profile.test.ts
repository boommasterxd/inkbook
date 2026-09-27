import { describe, expect, it, vi } from "vitest";

import { SvgSceneRenderer } from "../../../../src/rendering/scene";
import { FakeScheduler, FakeNode, FakeSceneStore } from "../../../unit/rendering/scene/fakes";
import {
  createPressureNavigationHarness,
  NAVIGATION_VISIBLE_STROKES,
  NAVIGATION_PAGE,
} from "../../../fixtures/rendering/pressure-navigation";
import { createSceneFixture } from "../../../fixtures/rendering/scene";
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

    runCameraFrames(renderer, scheduler);
    const cameraStats = renderer.instrumentation();
    expect(cameraStats.spatialQueries).toBe(0);
    expect(cameraStats.visibilityHysteresisHits).toBe(PREVIEW_FRAMES);
    expect(cameraStats).toMatchObject({ domEntrants: 0, domExits: 0, geometryBuilds: 0 });

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

  renderer.setViewport({ height: 100, left: 0, top: 10_000, width: 100 });
  scheduler.runAll();
  expect(renderer.instrumentation().pathCacheEntries).toBe(NAVIGATION_VISIBLE_STROKES);
  expect(renderer.instrumentation().pathCacheBytes).toBeLessThanOrEqual(32 * 1_024 * 1_024);
  renderer.resetInstrumentation();
  renderer.setViewport({ height: 100, left: 0, top: 0, width: 100 });
  scheduler.runAll();
  expect(renderer.instrumentation()).toMatchObject({
    geometryBuilds: 0,
    pathCacheHits: NAVIGATION_VISIBLE_STROKES,
  });
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
  expect(renderer.instrumentation().visibilityHysteresisHits).toBe(0);
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
    if (delay > 0) {
      expect(renderer.hasPendingSceneCommit).toBe(true);
      expect(renderer.instrumentation()).toMatchObject({
        backgroundBuilds: 0,
        spatialQueries: 1,
      });
      expect(scheduler.pendingCount).toBe(1);
      scheduler.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
      scheduler.runNext();
    }
    expect(renderer.hasPendingSceneCommit).toBe(false);
    expect(scheduler.pendingCount).toBe(0);
    expect(renderer.instrumentation()).toMatchObject({
      frames: delay === 0 ? 1 : 2,
      backgroundBuilds: 1,
      backgroundBudgetDeferrals: delay === 0 ? 0 : 1,
      geometryBuilds: 0,
    });
    // One camera write and a fixed background/palette update, independent of page height.
    expect(writes.mock.calls.length).toBeLessThanOrEqual(32);
    now.mockRestore();
    writes.mockRestore();
    renderer.destroy();
  },
);
