import { describe, expect, it } from "vitest";

import {
  DENSE_VIEWPORT_PROFILES,
  createDenseViewportFixture,
  createDenseViewportHarness,
} from "../../../integration/rendering/scene/dense-viewport-fixture";

describe("dense viewport reconciliation performance", () => {
  for (const profile of DENSE_VIEWPORT_PROFILES) {
    it(`bounds ${profile.name} reconciliation frame work`, () => {
      expect(run(profile.viewport)).toBeLessThanOrEqual(profile.frameLimit);
    });
  }
});

function run(viewport: readonly [number, number]): number {
  const fixture = createDenseViewportFixture();
  const { renderer, scheduler, store } = createDenseViewportHarness({ fixture, viewport });
  scheduler.runAll();
  const instrumentation = renderer.instrumentation();
  const frames = instrumentation.frames;
  expect(instrumentation).toMatchObject({
    geometryBuilds: fixture.records.length,
    domEntrants: fixture.records.length,
    spatialQueries: 1,
    pathCacheEntries: 0,
  });
  expect(store.queryCount).toBe(1);
  expect(scheduler.pendingCount).toBe(0);
  expect(renderer.mountedIds("highlight")).toEqual(fixture.highlightIds);
  expect(renderer.mountedIds("content")).toEqual(fixture.contentIds);
  renderer.destroy();
  expect(renderer.mountedCount).toBe(0);
  expect(scheduler.pendingCount).toBe(0);
  return frames;
}
