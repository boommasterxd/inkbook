import { describe, expect, it } from "vitest";

import {
  DENSE_VIEWPORT_PROFILES,
  createDenseViewportFixture,
  createDenseViewportHarness,
} from "../../../integration/rendering/scene/dense-viewport-fixture";
import { expectTiming } from "../../timing-assertions";

describe("dense viewport reconciliation performance", () => {
  for (const profile of DENSE_VIEWPORT_PROFILES) {
    it(`meets the isolated ${profile.name} frame and elapsed deadlines`, async ({ annotate }) => {
      run(profile.viewport);
      const durations: number[] = [];
      const frames: number[] = [];

      for (let measurement = 0; measurement < 5; measurement += 1) {
        const result = run(profile.viewport);
        durations.push(result.durationMs);
        frames.push(result.frames);
      }

      const maximumDuration = Math.max(...durations);
      const maximumFrames = Math.max(...frames);
      expectTiming(maximumDuration, profile.elapsedLimitMs);
      expect(maximumFrames).toBeLessThanOrEqual(profile.frameLimit);
      await annotate(
        `${profile.name}: max=${maximumDuration.toFixed(3)} ms, frames=${String(maximumFrames)}`,
        "performance",
      );
    });
  }
});

function run(viewport: readonly [number, number]): { durationMs: number; frames: number } {
  const fixture = createDenseViewportFixture();
  const startedAt = performance.now();
  const { renderer, scheduler, store } = createDenseViewportHarness({ fixture, viewport });
  scheduler.runAll();
  const durationMs = performance.now() - startedAt;
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
  return { durationMs, frames };
}
