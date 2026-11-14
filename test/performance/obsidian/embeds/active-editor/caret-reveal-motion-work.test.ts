import { expect, it } from "vitest";
import { createInputState } from "../../../../../src/editor/input/index";
import { OUTER_PAGE_WIDTH } from "../../../../../src/editor/zoom/zoom";
import { ActiveEditorNavigation } from "../../../../../src/obsidian/embeds/active-editor/navigation/navigation";
import { TRANSITION_DURATIONS } from "../../../../../src/rendering/motion/transitions";
import { INTERACTION_REFRESH_PROFILE } from "../../../interaction-refresh-profile";
import { buildNavigationHarness } from "../../../../fixtures/obsidian/navigation-refresh-profile";

it("bounds retargeted caret reveal to one shared frame and one native layout read/write per frame", () => {
  const state = buildNavigationHarness(
    { ActiveEditorNavigation, createInputState, OUTER_PAGE_WIDTH },
    INTERACTION_REFRESH_PROFILE.refreshRate,
  );
  const scroll = Object.getOwnPropertyDescriptor(state.owner, "scrollTop")!;
  Object.defineProperty(state.owner, "scrollTop", {
    get: () => scroll.get!.call(state.owner) as number,
    set: (value: number) => {
      scroll.set!.call(state.owner, value);
      state.rect.top = 300 - value;
    },
  });
  const reveal = (bottom: number) =>
    state.navigation.revealBounds(
      { minX: 100, maxX: 101, minY: bottom - 20, maxY: bottom },
      undefined,
      undefined,
      true,
    );
  reveal(1000);
  state.frames.flush();
  state.frames.flush();
  reveal(1200);
  state.resetWrites();
  const maximumFrames = Math.ceil(
    TRANSITION_DURATIONS.automaticPageGrowth / state.frames.frameDurationMs,
  );
  for (let frame = 0; frame < maximumFrames && state.frames.pending; frame++) state.frames.flush();
  expect(state.frames.pending).toBe(0);
  expect(state.frames.maxPending).toBe(1);
  expect(state.layoutReads).toBeLessThanOrEqual(maximumFrames);
  expect(state.hostBoundsReads.container).toBe(state.layoutReads);
  expect(state.hostBoundsReads.owner).toBe(state.layoutReads);
  expect(state.scrollWrites).toBeLessThanOrEqual(maximumFrames);
  expect(state.layoutWrites).toBe(0);
  expect(state.rect.top + 1 + 1200 * state.navigation.zoom).toBeCloseTo(484);
  reveal(1600);
  state.navigation.cancelPanMomentum();
  expect(state.frames.pending).toBe(0);
  state.navigation.dispose();
  expect(state.frames.pendingTimers).toBe(0);
});
