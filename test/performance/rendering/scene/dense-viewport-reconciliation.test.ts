import { describe, expect, it } from "vitest";

import {
  DENSE_VIEWPORT_PROFILES,
  createDenseViewportFixture,
  createDenseViewportHarness,
} from "../../../integration/rendering/scene/dense-viewport-fixture";
import { timingBudget } from "../../timing-budget";

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
      expect(maximumDuration).toBeLessThanOrEqual(timingBudget(profile.elapsedLimitMs));
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
  const { renderer, scheduler } = createDenseViewportHarness({ fixture, viewport });
  scheduler.runAll();
  const durationMs = performance.now() - startedAt;
  const frames = renderer.instrumentation().frames;
  expect(renderer.mountedIds("highlight")).toEqual(fixture.highlightIds);
  expect(renderer.mountedIds("content")).toEqual(fixture.contentIds);
  renderer.destroy();
  return { durationMs, frames };
}
