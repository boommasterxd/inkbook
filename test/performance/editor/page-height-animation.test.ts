import { describe, expect, it } from "vitest";

import { ActiveHeightTransition } from "../../../src/obsidian/embeds/active-editor/height-transition";
import { transitionDurations } from "../../../src/rendering/ui/motion";
import {
  INTERACTION_REFRESH_PROFILE,
  interactionProfileAnnotation,
} from "../interaction-refresh-profile";
import { timingBudget } from "../timing-budget";
import { pageHeightPercentile } from "./page-height-performance-fixture";

describe("automatic page-height performance", () => {
  it(`keeps ${INTERACTION_REFRESH_PROFILE.refreshRate} Hz growth and shrink animation frames below one millisecond`, async ({
    annotate,
  }) => {
    const harness = transitionHarness(INTERACTION_REFRESH_PROFILE.frameDurationMs);
    for (let transition = 0; transition < 500; transition += 1) {
      harness.run(transition % 2 === 0 ? [480, 720] : [720, 480]);
    }

    const p99 = pageHeightPercentile(harness.frameDurations, 0.99);
    expect(p99).toBeLessThanOrEqual(timingBudget(1));
    expect(harness.maximumFramesPerTransition).toBeLessThanOrEqual(
      Math.ceil(
        transitionDurations.automaticPageGrowth / INTERACTION_REFRESH_PROFILE.frameDurationMs,
      ) + 2,
    );
    expect(harness.incompleteTransitions).toBe(0);
    await annotate(
      interactionProfileAnnotation("automatic page growth and shrink", p99),
      "performance",
    );
  });
});

function transitionHarness(frameDurationMs: number) {
  const classNames = new Set<string>();
  const frames: FrameRequestCallback[] = [];
  const ownerWindow = {
    cancelAnimationFrame: () => frames.shift(),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    },
  } as unknown as Window;
  const container = {
    classList: {
      add: (name: string) => classNames.add(name),
      remove: (name: string) => classNames.delete(name),
    },
    style: { removeProperty: () => "", setProperty: () => undefined },
  } as unknown as HTMLElement;
  const transition = new ActiveHeightTransition(container, ownerWindow);
  const frameDurations: number[] = [];
  let maximumFramesPerTransition = 0;
  let incompleteTransitions = 0;
  return {
    frameDurations,
    get incompleteTransitions() {
      return incompleteTransitions;
    },
    get maximumFramesPerTransition() {
      return maximumFramesPerTransition;
    },
    run: ([from, to]: readonly [number, number]) => {
      let completed = false;
      transition.begin({
        applyFrame: () => undefined,
        applySurfaceTarget: () => undefined,
        currentRenderedHeight: from,
        onComplete: () => {
          completed = true;
        },
        sceneCommitPending: () => false,
        targetRenderedHeight: to,
      });
      let elapsed = 0;
      let frameCount = 0;
      while (frames.length > 0) {
        const frame = frames.shift();
        if (frame === undefined) break;
        const started = performance.now();
        frame(elapsed);
        frameDurations.push(performance.now() - started);
        elapsed += frameDurationMs;
        frameCount += 1;
      }
      maximumFramesPerTransition = Math.max(maximumFramesPerTransition, frameCount);
      if (!completed || transition.active) incompleteTransitions += 1;
      expect(elapsed).toBeLessThanOrEqual(
        transitionDurations.automaticPageGrowth + frameDurationMs * 2,
      );
    },
  };
}
