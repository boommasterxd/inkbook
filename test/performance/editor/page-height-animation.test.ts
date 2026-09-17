import { describe, expect, it } from "vitest";

import { ActiveHeightTransition } from "../../../src/obsidian/embeds/active-editor/height-transition";
import { TransitionScrollStability } from "../../../src/obsidian/embeds/transition-scroll-stability";
import type { BrowserScrollElement } from "../../../src/obsidian/scrolling/index";
import { TRANSITION_DURATIONS } from "../../../src/rendering/motion/transitions";
import {
  INTERACTION_REFRESH_PROFILE,
  interactionProfileAnnotation,
} from "../interaction-refresh-profile";
import { expectTiming } from "../timing-assertions";
import { readyResponsiveFixture } from "../../integration/obsidian/embeds/active-editor-responsive-layout-fixture";
import { pageHeightPercentile } from "./page-height-performance-fixture";

describe("automatic page-height performance", () => {
  it(`keeps ${INTERACTION_REFRESH_PROFILE.refreshRate} Hz growth and shrink animation frames below one millisecond`, async ({
    annotate,
  }) => {
    const harness = transitionHarness(INTERACTION_REFRESH_PROFILE.frameDurationMs);
    for (let transition = 0; transition < 500; transition += 1) {
      harness.run(transition % 2 === 0 ? [480, 720] : [720, 480], transition % 4 < 2);
    }

    const p99 = pageHeightPercentile(harness.frameDurations, 0.99);
    expectTiming(p99, 1);
    expect(harness.maximumFramesPerTransition).toBeLessThanOrEqual(
      Math.ceil(
        TRANSITION_DURATIONS.automaticPageGrowth / INTERACTION_REFRESH_PROFILE.frameDurationMs,
      ) + 2,
    );
    expect(harness.incompleteTransitions).toBe(0);
    expect(harness.overlongTransitions).toBe(0);
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
    let incorrectFrames = 0;
    for (let frame = 0; frame < durations.length; frame += 1) {
      if (frame % 2 === 0) harness.applyHostDrift(4);
      const started = performance.now();
      harness.flushFrame();
      durations[frame] = performance.now() - started;
      if (harness.scrollTop !== 1_200) incorrectFrames += 1;
    }
    release();
    harness.flushFrames();
    harness.stability.dispose();
    expect(incorrectFrames).toBe(0);

    const p99 = pageHeightPercentile(durations, 0.99);
    expectTiming(p99, 0.25);
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
  let overlongTransitions = 0;
  return {
    frameDurations,
    get incompleteTransitions() {
      return incompleteTransitions;
    },
    get overlongTransitions() {
      return overlongTransitions;
    },
    get maximumFramesPerTransition() {
      return maximumFramesPerTransition;
    },
    run: ([from, to]: readonly [number, number], stabilizeScroll: boolean) => {
      let completed = false;
      transition.begin({
        applyFrame: () => undefined,
        applySurfaceTarget: () => undefined,
        currentRenderedHeight: from,
        onComplete: () => {
          completed = true;
        },
        sceneCommitPending: () => false,
        stabilizeScroll,
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
      if (!(elapsed <= TRANSITION_DURATIONS.automaticPageGrowth + frameDurationMs * 2)) {
        overlongTransitions += 1;
      }
    },
  };
}

it(`avoids toolbar measurement during ${INTERACTION_REFRESH_PROFILE.refreshRate} Hz root-height animation`, async ({
  annotate,
}) => {
  let invalidations = 0;
  const h = readyResponsiveFixture({
    invalidateLayout: () => {
      invalidations += 1;
    },
  });
  const initialInvalidations = invalidations;
  const reads = h.toolbarReads();
  const notifications = Array.from(
    { length: INTERACTION_REFRESH_PROFILE.sampleCount },
    (_, frame) =>
      h.prepareRootResize(
        700,
        200 + 100 * Math.sin((frame * INTERACTION_REFRESH_PROFILE.frameDurationMs) / 240),
      ),
  );
  const durations = new Array<number>(notifications.length);
  let incorrectInvalidations = 0;
  for (let frame = 0; frame < notifications.length; frame += 1) {
    const notify = notifications[frame]!;
    const started = performance.now();
    notify();
    h.flushFrames();
    durations[frame] = performance.now() - started;
    if (invalidations !== initialInvalidations + frame + 1) incorrectInvalidations += 1;
  }
  expect(incorrectInvalidations).toBe(0);
  expect(invalidations - initialInvalidations).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
  expect(h.toolbarReads()).toBe(reads);
  expect(h.onLayout).not.toHaveBeenCalled();
  h.layout.dispose();
  const p99 = pageHeightPercentile(durations, 0.99);
  expectTiming(p99, 0.25);
  await annotate(interactionProfileAnnotation("height-only layout observer", p99), "performance");
});
