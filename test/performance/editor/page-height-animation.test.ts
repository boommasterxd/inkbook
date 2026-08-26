import { describe, expect, it } from "vitest";

import { ActiveHeightTransition } from "../../../src/obsidian/embeds/active-editor/height-transition";
import { TransitionScrollStability } from "../../../src/obsidian/embeds/transition-scroll-stability";
import type { BrowserScrollElement } from "../../../src/obsidian/scrolling/index";
import { TRANSITION_DURATIONS } from "../../../src/rendering/motion/transitions";
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
        TRANSITION_DURATIONS.automaticPageGrowth / INTERACTION_REFRESH_PROFILE.frameDurationMs,
      ) + 2,
    );
    expect(harness.incompleteTransitions).toBe(0);
    await annotate(
      interactionProfileAnnotation("automatic page growth and shrink", p99),
      "performance",
    );
  });

  it(`keeps ${INTERACTION_REFRESH_PROFILE.refreshRate} Hz visual scroll anchoring constant-time`, async ({
    annotate,
  }) => {
    const harness = scrollStabilityHarness();
    const release = harness.stability.begin();
    const durations = new Array<number>(INTERACTION_REFRESH_PROFILE.sampleCount);
    for (let frame = 0; frame < durations.length; frame += 1) {
      if (frame % 2 === 0) harness.applyHostDrift(4);
      const started = performance.now();
      harness.flushFrame();
      durations[frame] = performance.now() - started;
      expect(harness.scrollTop).toBe(1_200);
    }
    release();
    harness.flushFrames();
    harness.stability.dispose();

    const p99 = pageHeightPercentile(durations, 0.99);
    expect(p99).toBeLessThanOrEqual(timingBudget(0.25));
    await annotate(interactionProfileAnnotation("visual transition scroll anchoring", p99));
  });
});

function scrollStabilityHarness() {
  const frames: FrameRequestCallback[] = [];
  const classes = new Set<string>();
  let scrollTop = 1_200;
  const ownerDocument = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    scrollingElement: null,
  };
  const owner = {
    addEventListener: () => undefined,
    classList: { add: () => undefined, remove: () => undefined },
    clientHeight: 800,
    ownerDocument,
    removeEventListener: () => undefined,
    scrollHeight: 10_000,
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value: number) {
      scrollTop = value;
    },
  } as unknown as BrowserScrollElement;
  const root = {
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
    },
    getBoundingClientRect: () => ({ top: 2_000 - scrollTop }),
  } as unknown as HTMLElement;
  const ownerWindow = {
    cancelAnimationFrame: () => frames.shift(),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    },
  } as unknown as Window;
  const stability = new TransitionScrollStability({ owner: () => owner, ownerWindow, root });
  const flushFrame = (): void => {
    const frame = frames.shift();
    if (frame === undefined) throw new Error("No stabilization frame is pending.");
    frame(0);
  };
  return {
    applyHostDrift: (delta: number) => {
      scrollTop += delta;
    },
    flushFrame,
    flushFrames: () => {
      while (frames.length > 0) flushFrame();
    },
    get scrollTop() {
      return scrollTop;
    },
    stability,
  };
}

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
        TRANSITION_DURATIONS.automaticPageGrowth + frameDurationMs * 2,
      );
    },
  };
}
