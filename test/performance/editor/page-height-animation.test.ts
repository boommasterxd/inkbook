import { describe, expect, it } from "vitest";

import { ActiveHeightTransition } from "../../../src/obsidian/embeds/active-editor/layout/height-transition";
import { TransitionScrollStability } from "../../../src/obsidian/embeds/presentation/transition-scroll-stability";
import type { BrowserScrollElement } from "../../../src/obsidian/scrolling/index";
import { TRANSITION_DURATIONS } from "../../../src/rendering/motion/transitions";
import { INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";
import { readyResponsiveFixture } from "../../integration/obsidian/embeds/active-editor/layout/active-editor-responsive-layout-fixture";
import { workSchedulerFromFrames } from "../../fixtures/obsidian/work-scheduler";

describe("automatic page-height performance", () => {
  it(`keeps ${INTERACTION_REFRESH_PROFILE.refreshRate} Hz growth and shrink animation frames bounded`, () => {
    const harness = transitionHarness(INTERACTION_REFRESH_PROFILE.frameDurationMs);
    for (let transition = 0; transition < 4; transition += 1) {
      harness.run(transition % 2 === 0 ? [480, 720] : [720, 480], transition % 4 < 2);
    }

    expect(harness.maximumFramesPerTransition).toBeLessThanOrEqual(
      Math.ceil(
        TRANSITION_DURATIONS.automaticPageGrowth / INTERACTION_REFRESH_PROFILE.frameDurationMs,
      ) + 2,
    );
    expect(harness.incompleteTransitions).toBe(0);
    expect(harness.overlongTransitions).toBe(0);
  });

  it(`keeps ${INTERACTION_REFRESH_PROFILE.refreshRate} Hz visual scroll anchoring bounded`, () => {
    const harness = scrollStabilityHarness();
    const release = harness.stability.begin();
    let incorrectFrames = 0;
    for (let frame = 0; frame < INTERACTION_REFRESH_PROFILE.sampleCount; frame += 1) {
      if (frame % 2 === 0) harness.applyHostDrift(4);
      harness.flushFrame();
      if (harness.scrollTop !== 1_200) incorrectFrames += 1;
    }
    release();
    harness.flushFrames();
    harness.stability.dispose();
    expect(incorrectFrames).toBe(0);
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
  const stability = new TransitionScrollStability({
    owner: () => owner,
    ownerWindow,
    root,
    workScheduler: workSchedulerFromFrames(ownerWindow),
  });
  const flushFrame = (): void => {
    expect(frames).toHaveLength(1);
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
  const transition = new ActiveHeightTransition(container, workSchedulerFromFrames(ownerWindow));
  let maximumFramesPerTransition = 0;
  let incompleteTransitions = 0;
  let overlongTransitions = 0;
  return {
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
        expect(frames).toHaveLength(1);
        expect(frameCount).toBeLessThan(100);
        const frame = frames.shift();
        if (frame === undefined) break;
        frame(elapsed);
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

it(`avoids toolbar measurement during ${INTERACTION_REFRESH_PROFILE.refreshRate} Hz root-height animation`, () => {
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
  let incorrectInvalidations = 0;
  for (let frame = 0; frame < notifications.length; frame += 1) {
    const notify = notifications[frame]!;
    notify();
    h.flushFrames();
    if (invalidations !== initialInvalidations + frame + 1) incorrectInvalidations += 1;
  }
  expect(incorrectInvalidations).toBe(0);
  expect(invalidations - initialInvalidations).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
  expect(h.toolbarReads()).toBe(reads);
  expect(h.onLayout).not.toHaveBeenCalled();
  h.layout.dispose();
});
