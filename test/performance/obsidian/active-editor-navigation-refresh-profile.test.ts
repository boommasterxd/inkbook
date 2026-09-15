import {
  createNavigationHarness as buildNavigationHarness,
  navigationFrame,
} from "../../fixtures/obsidian/navigation-profile";
import { describe, expect, it } from "vitest";

import { createInputState } from "../../../src/editor/input/index";
import { OUTER_PAGE_WIDTH } from "../../../src/editor/zoom/zoom";
import { ActiveEditorNavigation } from "../../../src/obsidian/embeds/active-editor/navigation";
import {
  INTERACTION_REFRESH_PROFILE,
  interactionP99,
  interactionProfileAnnotation,
  measureInteractionFrames,
} from "../interaction-refresh-profile";
import { expectTiming } from "../timing-assertions";

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz navigation profile`, () => {
  it("keeps continuous anchored trackpad zoom within budget", async ({ annotate }) => {
    const harness = createNavigationHarness();
    let claimedFrames = 0;
    const update = navigationFrame(0, harness);
    const durations = measureInteractionFrames((frame) => {
      if (update(frame)) claimedFrames += 1;
    });

    const p99 = interactionP99(durations);
    expect(claimedFrames).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(harness.cameraWrites).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(harness.layoutWrites).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expectTiming(p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    await annotate(interactionProfileAnnotation("trackpad zoom", p99), "performance");
    harness.navigation.dispose();
  });

  it("keeps coalesced horizontal pan and native vertical scroll within budget", async ({
    annotate,
  }) => {
    const harness = createPanningHarness();
    const durations = measureInteractionFrames(navigationFrame(1, harness));
    harness.navigation.finish();

    const p99 = interactionP99(durations);
    expect(harness.cameraWrites).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(harness.scrollWrites).toBeGreaterThan(0);
    expectTiming(p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    await annotate(interactionProfileAnnotation("pan and native scroll", p99), "performance");
    harness.navigation.dispose();
  });

  it("keeps horizontal trackpad handoff and momentum within budget", async ({ annotate }) => {
    const harness = createPanningHarness();
    let claimedEvents = 0;
    const update = navigationFrame(2, harness);
    const durations = measureInteractionFrames((frame) => {
      if (update(frame)) claimedEvents += 1;
    });

    const p99 = interactionP99(durations);
    expect(claimedEvents).toBe((INTERACTION_REFRESH_PROFILE.sampleCount / 4) * 3);
    expect(harness.cameraWrites).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(harness.frames.maxPending).toBe(1);
    expect(harness.scrollWrites).toBe(0);
    expectTiming(p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    await annotate(interactionProfileAnnotation("trackpad pan handoff", p99), "performance");
    harness.navigation.dispose();
  });

  it("keeps horizontal touch momentum within budget", async ({ annotate }) => {
    const harness = createPanningHarness();
    const durations = measureInteractionFrames(navigationFrame(3, harness));

    const p99 = interactionP99(durations);
    expect(harness.cameraWrites).toBeGreaterThan(0);
    expectTiming(p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    await annotate(interactionProfileAnnotation("touch pan momentum", p99), "performance");
    harness.navigation.dispose();
  });
});

function createPanningHarness(): ReturnType<typeof createNavigationHarness> {
  const harness = createNavigationHarness();
  expect(harness.navigation.restoreViewState({ cameraX: -100, zoom: 1 })).toBe(true);
  harness.resetWrites();
  return harness;
}

function createNavigationHarness() {
  return buildNavigationHarness(
    { ActiveEditorNavigation, createInputState, OUTER_PAGE_WIDTH },
    INTERACTION_REFRESH_PROFILE.refreshRate,
  );
}
