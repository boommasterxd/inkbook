// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createLoadingPlaceholder } from "../../../src/obsidian/embeds/loading-placeholder";
import { ColorSchemeBroadcaster } from "../../../src/obsidian/theme/color-scheme";
import { FakePresentationElement } from "../../fixtures/obsidian/presentation-dom";
import { expectTiming } from "../timing-assertions";
import { TRANSITION_DURATIONS } from "../../../src/rendering/motion/transitions";
import { exitHarness } from "../../unit/obsidian/embeds/presentation-exit-fixture";
import { entranceHarness } from "../../unit/obsidian/embeds/presentation-entrance-fixture";
import { pageHeightPercentile } from "../editor/page-height-performance-fixture";
import {
  INTERACTION_REFRESH_PROFILE,
  interactionProfileAnnotation,
} from "../interaction-refresh-profile";

describe("presentation entrance performance", () => {
  it.for(["preview", "editor"] as const)(
    `keeps ${INTERACTION_REFRESH_PROFILE.refreshRate} Hz %s reveal frames below one millisecond`,
    async (target, { annotate }) => {
      const durations: number[] = [];
      let invalidFrames = 0;
      let invalidLifecycle = 0;
      for (let sample = 0; sample < 500; sample += 1) {
        const h = entranceHarness({ presented: false, initialHeight: sample % 2 === 0 ? 48 : 0 });
        h.entrance.prepare();
        if (target === "editor") h.entrance.holdForActivation();
        h.entrance.measure();
        if (target === "editor") {
          if (h.frames.size !== 0) invalidLifecycle += 1;
          if (h.entrance.revealActive(800) !== true) invalidLifecycle += 1;
        }
        invalidFrames += measureFrames(h, durations);
        if (h.entrance.pending !== false) invalidLifecycle += 1;
        if ((await h.entrance.ready) !== true) invalidLifecycle += 1;
        if (h.presented !== 1) invalidLifecycle += 1;
        if (h.frames.size !== 0) invalidLifecycle += 1;
        if (h.listeners.size !== 0) invalidLifecycle += 1;
      }
      const p99 = assertPresentationMeasurements(durations, invalidFrames, invalidLifecycle);
      await annotate(interactionProfileAnnotation(`${target} entrance`, p99), "performance");
    },
  );
});

it.for([false, true])(
  `animates loading placeholders and preserves handoff height at ${INTERACTION_REFRESH_PROFILE.refreshRate} Hz (early=%s)`,
  async (early, { annotate }) => {
    const durations: number[] = [];
    let invalidFrames = 0;
    let invalidHeights = 0;
    let retainedWork = 0;
    for (let sample = 0; sample < 500; sample += 1) {
      const h = loadingMotionHarness();
      if (!Object.is(h.loading.renderedHeight, 0)) invalidHeights += 1;
      invalidFrames += measureFrames(h, durations, early);
      const height = h.loading.renderedHeight;
      if (early) {
        if (!(height > 0)) invalidHeights += 1;
        if (!(height < 48)) invalidHeights += 1;
      } else if (height !== 48) invalidHeights += 1;
      const started = performance.now();
      h.loading.dispose();
      durations.push(performance.now() - started);
      if (!Object.is(h.loading.renderedHeight, height)) invalidHeights += 1;
      if (h.frames.size !== 0) retainedWork += 1;
      if (h.timers.size !== 0) retainedWork += 1;
      const preview = entranceHarness({ presented: false, initialHeight: height });
      preview.entrance.prepare();
      if (!Object.is(preview.renderedHeight, height)) invalidHeights += 1;
      preview.entrance.dispose();
    }
    expect(invalidFrames).toBe(0);
    expect(invalidHeights).toBe(0);
    expect(retainedWork).toBe(0);
    const p99 = pageHeightPercentile(durations, 0.99);
    expectTiming(p99, 1);
    await annotate(
      interactionProfileAnnotation("loading placeholder entrance", p99),
      "performance",
    );
  },
);

function loadingMotionHarness() {
  const host = new FakePresentationElement();
  const ownerWindow = host.ownerDocument.defaultView;
  if (ownerWindow === null) throw new Error("Missing owner window.");
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Set<number>();
  let nextId = 0;
  Object.assign(ownerWindow, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++nextId, callback);
      return nextId;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout: () => {
      timers.add(++nextId);
      return nextId;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const scheme = new ColorSchemeBroadcaster({ getColorScheme: () => "light" });
  const loading = createLoadingPlaceholder(host as unknown as HTMLElement, {
    motion: "system",
    scheme,
  });
  return {
    loading,
    frames,
    timers,
    frame: (time: number) => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(time);
    },
  };
}

function measureFrames(
  harness: {
    readonly frames: ReadonlyMap<number, FrameRequestCallback>;
    frame(time: number): void;
  },
  durations: number[],
  early = false,
): number {
  const frameDuration = INTERACTION_REFRESH_PROFILE.frameDurationMs;
  const frameBound = Math.ceil(TRANSITION_DURATIONS.automaticPageGrowth / frameDuration) + 2;
  let frames = 0;
  let violations = 0;
  while (harness.frames.size > 0 && frames <= frameBound) {
    if (harness.frames.size !== 1) violations += 1;
    const started = performance.now();
    harness.frame(frames * frameDuration);
    durations.push(performance.now() - started);
    frames += 1;
    if (early && frames === 3) break;
  }
  if (frames > frameBound) violations += 1;
  return violations;
}

it(`keeps ${INTERACTION_REFRESH_PROFILE.refreshRate} Hz exit frames below one millisecond`, async ({
  annotate,
}) => {
  const durations: number[] = [];
  let invalidFrames = 0;
  let invalidLifecycle = 0;
  for (let sample = 0; sample < 500; sample += 1) {
    const h = exitHarness(400, { before: 24, after: 24 });
    const ready = h.exit.begin();
    invalidFrames += measureFrames(h, durations);
    if ((await ready) !== true) invalidLifecycle += 1;
    if (!Object.is(h.height, 0)) invalidLifecycle += 1;
    if (h.frames.size !== 0) invalidLifecycle += 1;
    h.exit.dispose();
    if (h.listeners.size !== 0) invalidLifecycle += 1;
  }
  const p99 = assertPresentationMeasurements(durations, invalidFrames, invalidLifecycle);
  await annotate(interactionProfileAnnotation("presentation exit", p99), "performance");
});

function assertPresentationMeasurements(
  durations: readonly number[],
  frameViolations: number,
  lifecycleViolations: number,
): number {
  expect(frameViolations).toBe(0);
  expect(lifecycleViolations).toBe(0);
  const p99 = pageHeightPercentile(durations, 0.99);
  expectTiming(p99, 1);
  return p99;
}
