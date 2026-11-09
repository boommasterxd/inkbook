// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { TRANSITION_DURATIONS } from "../../../../../src/rendering/motion/transitions";
import { exitHarness } from "../../../../unit/obsidian/embeds/presentation-exit-fixture";
import { entranceHarness } from "../../../../unit/obsidian/embeds/presentation-entrance-fixture";
import { INTERACTION_REFRESH_PROFILE } from "../../../interaction-refresh-profile";

describe("presentation entrance performance", () => {
  it.for(["preview", "editor"] as const)(
    `keeps ${INTERACTION_REFRESH_PROFILE.refreshRate} Hz %s reveal frames coalesced and bounded`,
    async (target) => {
      let invalidFrames = 0;
      let invalidLifecycle = 0;
      for (let sample = 0; sample < 2; sample += 1) {
        const h = entranceHarness({ presented: false, initialHeight: sample % 2 === 0 ? 48 : 0 });
        h.entrance.prepare();
        if (target === "editor") h.entrance.holdForActivation();
        h.entrance.measure();
        if (target === "editor") {
          if (h.frames.size !== 0) invalidLifecycle += 1;
          if (h.entrance.revealActive(800) !== true) invalidLifecycle += 1;
        }
        invalidFrames += runFrames(h);
        if (h.entrance.pending !== false) invalidLifecycle += 1;
        if ((await h.entrance.ready) !== true) invalidLifecycle += 1;
        if (h.presented !== 1) invalidLifecycle += 1;
        if (h.frames.size !== 0) invalidLifecycle += 1;
        if (h.listeners.size !== 0) invalidLifecycle += 1;
      }
      assertPresentationContracts(invalidFrames, invalidLifecycle);
    },
  );
});

function runFrames(
  harness: {
    readonly frames: ReadonlyMap<number, FrameRequestCallback>;
    frame(time: number): void;
  },
  early = false,
): number {
  const frameDuration = INTERACTION_REFRESH_PROFILE.frameDurationMs;
  const frameBound = Math.ceil(TRANSITION_DURATIONS.automaticPageGrowth / frameDuration) + 2;
  let frames = 0;
  let violations = 0;
  while (harness.frames.size > 0 && frames <= frameBound) {
    if (harness.frames.size !== 1) violations += 1;

    harness.frame(frames * frameDuration);

    frames += 1;
    if (early && frames === 3) break;
  }
  if (frames > frameBound) violations += 1;
  return violations;
}

it(`keeps ${INTERACTION_REFRESH_PROFILE.refreshRate} Hz exit frames coalesced and bounded`, async () => {
  let invalidFrames = 0;
  let invalidLifecycle = 0;
  const h = exitHarness(400, { before: 24, after: 24 });
  const ready = h.exit.begin();
  invalidFrames += runFrames(h);
  if ((await ready) !== true) invalidLifecycle += 1;
  if (!Object.is(h.height, 0)) invalidLifecycle += 1;
  if (h.frames.size !== 0) invalidLifecycle += 1;
  h.exit.dispose();
  if (h.listeners.size !== 0) invalidLifecycle += 1;
  assertPresentationContracts(invalidFrames, invalidLifecycle);
});

function assertPresentationContracts(frameViolations: number, lifecycleViolations: number): void {
  expect(frameViolations).toBe(0);
  expect(lifecycleViolations).toBe(0);
}
