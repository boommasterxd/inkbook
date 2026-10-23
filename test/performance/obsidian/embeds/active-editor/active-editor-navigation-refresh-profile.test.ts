import { describe, expect, it } from "vitest";

import { createInputState } from "../../../../../src/editor/input/index";
import { OUTER_PAGE_WIDTH } from "../../../../../src/editor/zoom/zoom";
import { ActiveEditorNavigation } from "../../../../../src/obsidian/embeds/active-editor/navigation/navigation";
import {
  INTERACTION_REFRESH_PROFILE,
  runInteractionFrames,
} from "../../../interaction-refresh-profile";
import {
  buildNavigationHarness,
  startNavigationFlick,
} from "../../../../fixtures/obsidian/navigation-refresh-profile";

function expectSingleZoomPublication(harness: ReturnType<typeof buildNavigationHarness>): void {
  expect(harness.frames.pending).toBe(0);
  expect(harness.cameraWrites).toBe(1);
  expect(harness.inputWrites()).toBe(1);
  expect(harness.layoutWrites).toBe(1);
  expect(harness.scrollWrites).toBe(1);
  expect(harness.scrollReads).toBe(2);
  expect(harness.layoutReads).toBe(1);
  expect(harness.hostBoundsReads).toEqual({ container: 1, owner: 1 });
  expect(harness.workReads).toEqual({ page: 1, scrollHeight: 1 });
}

function expectNoNavigationWrites(harness: ReturnType<typeof buildNavigationHarness>): void {
  expect(harness.cameraWrites).toBe(0);
  expect(harness.inputWrites()).toBe(0);
  expect(harness.layoutWrites).toBe(0);
  expect(harness.scrollWrites).toBe(0);
  expect(harness.workReads).toEqual({ page: 0, scrollHeight: 0 });
}

function navigationFrame(mode: number, harness: ReturnType<typeof buildNavigationHarness>) {
  return (frame: number): boolean => {
    let claimed = false;
    if (mode === 0) {
      claimed = harness.navigation.updateWheel({
        clientX: 500,
        clientY: 300,
        ctrlKey: true,
        deltaMode: 0,
        deltaX: 0,
        deltaY: frame % 2 === 0 ? -4 : 4,
        metaKey: false,
      });
    } else if (mode === 1) {
      const delta = frame % 2 === 0 ? 3 : -3;
      harness.navigation.pan(delta);
      harness.navigation.scroll(delta);
    } else if (mode === 2) {
      if (frame % 4 < 3) {
        const direction = Math.floor(frame / 4) % 2 === 0 ? 1 : -1;
        claimed = harness.navigation.updateWheel({
          clientX: 500,
          clientY: 300,
          ctrlKey: false,
          deltaMode: 0,
          deltaX: direction * 6,
          deltaY: 1,
          metaKey: false,
          shiftKey: false,
        });
      }
    } else if (harness.frames.pending === 0) {
      startNavigationFlick(harness, frame % 2 === 0 ? 1 : -1);
    }
    if (harness.frames.pending > 0) harness.frames.flush();
    else harness.frames.advanceQuiet(harness.frames.frameDurationMs);
    return claimed;
  };
}

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz navigation profile`, () => {
  it("defers native wheel work through a renewable quiet tail and releases camera cancellation", () => {
    const harness = createNavigationHarness();
    expect(
      harness.navigation.updateWheel({
        clientX: 500,
        clientY: 300,
        deltaMode: 0,
        deltaX: 0,
        deltaY: 4,
      }),
    ).toBe(false);
    harness.frames.advanceQuiet(100);
    harness.navigation.updateWheel({
      clientX: 500,
      clientY: 300,
      deltaMode: 0,
      deltaX: 0,
      deltaY: 4,
    });
    harness.frames.advanceQuiet(100);
    harness.navigation.notifyScroll();
    harness.frames.advanceQuiet(119);
    expect(harness.activity).toEqual([true]);
    expect(harness.frames.pending).toBe(0);
    harness.frames.advanceQuiet(1);
    expect(harness.activity).toEqual([true, false]);
    harness.navigation.updateKeyboardStep(1, null);
    harness.frames.advanceQuiet(1_000);
    expect(harness.activity).toEqual([true, false, true]);
    harness.navigation.cancelNavigation();
    expect(harness.activity).toEqual([true, false, true, false]);
    expect(harness.frames.pending).toBe(0);
    expect(harness.frames.pendingTimers).toBe(0);
    expect(harness.frames.maxTimers).toBe(1);
    harness.navigation.dispose();
  });

  it("releases priority after the last camera frame and quiet tail", () => {
    const harness = createNavigationHarness();
    harness.navigation.updateKeyboardStep(1, null);
    while (harness.frames.pending > 0) harness.frames.flush();
    harness.frames.advanceQuiet(119);
    expect(harness.activity).toEqual([true]);
    harness.frames.advanceQuiet(1);
    expect(harness.activity).toEqual([true, false]);
    expect(harness.frames.pendingTimers).toBe(0);
    expect(harness.frames.maxTimers).toBe(1);
    harness.navigation.dispose();
  });
});

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz mixed zoom work`, () => {
  it("retains the separate discrete frame bound when continuous input joins a keyboard backlog", () => {
    const harness = createNavigationHarness();
    const fit = harness.navigation.zoom;
    for (let step = 0; step < 10; step += 1) harness.navigation.updateKeyboardStep(1, null);
    harness.navigation.updateWheel({
      clientX: 500,
      clientY: 300,
      ctrlKey: true,
      deltaMode: 0,
      deltaY: -1,
    });
    harness.frames.flush();
    expect(harness.navigation.zoom).toBeCloseTo(fit * 1.35 * Math.exp(0.01), 12);
    expect(harness.cameraWrites).toBe(1);
    expect(harness.layoutWrites).toBe(1);
    expect(harness.frames.pending).toBe(1);
    while (harness.frames.pending > 0) harness.frames.flush();
    expect(harness.navigation.zoom).toBeCloseTo(fit * 1.08 ** 10 * Math.exp(0.01), 12);
    expect(harness.cameraWrites).toBe(3);
    expect(harness.layoutWrites).toBe(3);
    expect(harness.hostBoundsReads).toEqual({ container: 3, owner: 3 });
    disposeActiveNavigation(harness);
  });
});

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz direct zoom work`, () => {
  it.each([[-120], [-60, -60], [-121, 1]])(
    "publishes direct deltas %j with one bounded host update",
    (...deltas: number[]) => {
      const harness = createNavigationHarness();
      const fit = harness.navigation.zoom;
      for (const deltaY of deltas)
        harness.navigation.updateWheel({
          clientX: 500,
          clientY: 300,
          ctrlKey: true,
          deltaMode: 0,
          deltaY,
        });
      expect(harness.frames.pending).toBe(1);
      expect(harness.layoutReads).toBe(0);
      expect(harness.cameraWrites).toBe(0);
      harness.frames.flush();
      expect(harness.navigation.zoom).toBeCloseTo(fit * Math.exp(1.2), 12);
      expectSingleZoomPublication(harness);
      disposeActiveNavigation(harness);
    },
  );

  it("coalesces absolute touch targets and keeps terminal work to the last input frame", () => {
    const harness = createPanningHarness();
    const midpoint = { x: 500, y: 200 };
    harness.navigation.beginPinchScreen(midpoint);
    harness.resetWrites();
    harness.navigation.updatePinchScreen(midpoint, 4);
    harness.navigation.updatePinchScreen({ x: 520, y: 220 }, 3.6);
    expect(harness.frames.pending).toBe(1);
    expect(harness.cameraWrites).toBe(0);
    harness.navigation.finish();
    harness.frames.flush();
    expect(harness.navigation.zoom).toBeCloseTo(3.6);
    expect(harness.navigation.cameraX).toBeCloseTo(520 / 3.6 - 600);
    expectSingleZoomPublication(harness);
    expect(harness.frames.maxPending).toBe(1);
    disposeActiveNavigation(harness);
  });

  it("moves an unchanged-scale touch midpoint in one camera frame without height writes", () => {
    const harness = createPanningHarness();
    harness.navigation.beginPinchScreen({ x: 500, y: 200 });
    harness.resetWrites();
    harness.navigation.updatePinchScreen({ x: 520, y: 220 }, 1);
    harness.frames.flush();
    expect(harness.navigation.cameraX).toBe(-80);
    expect(harness.cameraWrites).toBe(1);
    expect(harness.inputWrites()).toBe(0);
    expect(harness.layoutWrites).toBe(0);
    expect(harness.scrollWrites).toBe(1);
    expect(harness.frames.pending).toBe(0);
    disposeActiveNavigation(harness);
  });

  it("reuses the gesture scroll snapshot and skips stationary touch scroll work", () => {
    const harness = createPanningHarness();
    const midpoint = { x: 500, y: 200 };
    harness.navigation.beginPinchScreen(midpoint);
    expect(harness.scrollReads).toBe(1);
    expectMeasuredScrollNoOp(harness, () => harness.navigation.updatePinchScreen(midpoint, 1));
    expect(harness.cameraWrites).toBe(0);
    expect(harness.frames.maxPending).toBe(1);
    disposeActiveNavigation(harness);
  });

  it("discards canceled touch targets before any host writes", () => {
    const harness = createPanningHarness();
    harness.navigation.beginPinchScreen({ x: 500, y: 200 });
    harness.resetWrites();
    harness.navigation.updatePinchScreen({ x: 600, y: 300 }, 4);
    harness.navigation.cancelNavigation();
    expect(harness.frames.pending).toBe(0);
    expectNoNavigationWrites(harness);
    expect(harness.activity).toEqual([true, false]);
    harness.navigation.dispose();
    expect(harness.frames.pendingTimers).toBe(0);
  });
});

it("keeps repeated native pan at the boundary free of scroll writes and readbacks", () => {
  const harness = createPanningHarness();
  harness.navigation.scroll(10_000);
  harness.frames.flush();
  expectMeasuredScrollNoOp(harness, () => harness.navigation.scroll(10));
  // The adapter keeps a fixed container top after the first projected scroll;
  // the next fresh measurement therefore applies that external geometry once.
  expect(harness.cameraWrites).toBe(1);
  disposeActiveNavigation(harness);
});

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz navigation work`, () => {
  it("reads every clamped pan frame but emits no unchanged camera or input feedback", () => {
    const harness = createPanningHarness();
    harness.navigation.pan(10_000);
    harness.frames.flush();
    harness.resetWrites();
    runInteractionFrames(() => {
      harness.navigation.pan(10);
      harness.frames.flush();
    });
    expect(harness.layoutReads).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expectNoNavigationWrites(harness);
    disposeActiveNavigation(harness);
  });
  it.each([0, 1, 2])("leaves native vertical wheel mode %s free of layout reads", (deltaMode) => {
    const harness = createPanningHarness();
    runInteractionFrames(() => {
      expect(
        harness.navigation.updateWheel({
          clientX: 500,
          clientY: 300,
          deltaMode,
          deltaX: 0,
          deltaY: 4,
          ctrlKey: false,
          metaKey: false,
          shiftKey: false,
        }),
      ).toBe(false);
    });
    expect(harness.layoutReads).toBe(0);
    expect(harness.frames.pending).toBe(0);
    disposeActiveNavigation(harness);
  });

  it("keeps continuous anchored trackpad zoom with coalesced work", () => {
    const harness = createNavigationHarness();
    let claimedFrames = 0;
    const update = navigationFrame(0, harness);
    runInteractionFrames((frame) => {
      if (update(frame)) claimedFrames += 1;
    });

    expect(claimedFrames).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(harness.cameraWrites).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(harness.layoutWrites).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    // The viewport's measured client height is reused for the projected native range.
    expect(harness.layoutReads).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(harness.workReads.scrollHeight).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(harness.workReads.page).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    // Keep the post-height-write read: browsers may clamp the requested offset.
    expect(harness.scrollReads).toBe(INTERACTION_REFRESH_PROFILE.sampleCount * 2);

    disposeActiveNavigation(harness);
  });

  it("keeps coalesced horizontal pan and native vertical scroll with coalesced work", () => {
    const harness = createPanningHarness();
    runInteractionFrames(navigationFrame(1, harness));
    harness.navigation.finish();

    expect(harness.cameraWrites).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(harness.scrollWrites).toBeGreaterThan(0);

    disposeActiveNavigation(harness);
  });

  it.each([
    { input: "trackpad", mode: 2 },
    { input: "touch", mode: 3 },
  ])("keeps horizontal $input movement with coalesced work", ({ mode }) => {
    const harness = createPanningHarness();
    let claimedEvents = 0;
    const update = navigationFrame(mode, harness);
    runInteractionFrames((frame) => {
      if (update(frame)) claimedEvents += 1;
    });

    if (mode === 2) {
      expect(claimedEvents).toBe((INTERACTION_REFRESH_PROFILE.sampleCount / 4) * 3);
      expect(harness.cameraWrites).toBe(claimedEvents);
      expect(harness.layoutReads).toBe(claimedEvents);
      expect(harness.frames.pending).toBe(1);
    } else expect(harness.cameraWrites).toBeGreaterThan(0);
    expect(harness.frames.maxPending).toBe(1);
    expect(harness.cameraWrites).toBeLessThanOrEqual(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(harness.scrollWrites).toBe(0);
    expect(harness.workReads.scrollHeight).toBe(0);
    expect(harness.workReads.page).toBe(0);
    expect(harness.layoutWrites).toBe(0);
    expect(harness.layoutReads).toBeLessThanOrEqual(INTERACTION_REFRESH_PROFILE.sampleCount);

    disposeActiveNavigation(harness);
  });
});

it("preserves native horizontal deltas across bursts and gaps with one quiet frame queued", () => {
  const harness = createPanningHarness();
  const initialCamera = harness.navigation.cameraX;
  let screenTravel = 0;
  runInteractionFrames((frame) => {
    const deltaX = frame % 2 === 0 ? 20 : -20;
    for (let event = 0; event < 4; event += 1) {
      expect(
        harness.navigation.updateWheel({
          clientX: 500,
          clientY: 300,
          deltaMode: 0,
          deltaX,
          deltaY: 0,
          ctrlKey: false,
          metaKey: false,
          shiftKey: false,
        }),
      ).toBe(true);
      screenTravel -= deltaX;
    }
    expect(harness.frames.pending).toBe(1);
    harness.frames.flush();
    expect(harness.navigation.cameraX).toBeCloseTo(initialCamera + screenTravel);
    expect(harness.frames.pending).toBe(1);
    harness.frames.advanceQuiet(80);
  });
  expect(harness.cameraWrites).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
  expect(harness.layoutReads).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
  expect(harness.frames.maxPending).toBe(1);
  expect(harness.scrollWrites).toBe(0);
  expect(harness.layoutWrites).toBe(0);
  expect(harness.workReads).toEqual({ page: 0, scrollHeight: 0 });
  disposeActiveNavigation(harness);
});

it.each([3, 0.05])("bounds host work for %s px trackpad release", (deltaX) => {
  const harness = createPanningHarness();
  const initialCamera = harness.navigation.cameraX;
  for (let sample = 0; sample < 3; sample += 1) {
    harness.navigation.updateWheel({
      clientX: 500,
      clientY: 300,
      deltaMode: 0,
      deltaX,
      deltaY: 0,
    });
    harness.frames.flush();
    expect(harness.navigation.cameraX).toBeCloseTo(initialCamera - deltaX * (sample + 1));
  }
  expect(harness.cameraWrites).toBe(3);
  expect(harness.layoutReads).toBe(3);
  const releaseDeadline =
    harness.frames.now -
    harness.frames.frameDurationMs +
    Math.max(32, harness.frames.frameDurationMs * 3);
  harness.resetWrites();
  while (harness.frames.now + harness.frames.frameDurationMs < releaseDeadline - 1e-9) {
    harness.frames.flush();
    expect(harness.frames.pending).toBe(1);
    expectNoNavigationWrites(harness);
    expect(harness.layoutReads).toBe(0);
    expect(harness.scrollReads).toBe(0);
    expect(harness.hostBoundsReads).toEqual({ container: 0, owner: 0 });
  }
  // A release exactly on a frame boundary may publish its first movement next frame.
  harness.frames.flush();
  if (harness.frames.pending > 0 && harness.cameraWrites === 0) harness.frames.flush();
  if (deltaX === 3) {
    expect(harness.cameraWrites).toBe(1);
    expect(harness.layoutReads).toBe(1);
    expect(harness.scrollReads).toBe(1);
    expect(harness.hostBoundsReads).toEqual({ container: 1, owner: 1 });
    expect(harness.navigation.cameraX).toBeLessThan(initialCamera - deltaX * 3);
    expect(harness.frames.pending).toBe(1);
  } else {
    expect(harness.frames.pending).toBe(0);
    expect(harness.cameraWrites).toBe(0);
    expect(harness.layoutReads).toBe(0);
    expect(harness.scrollReads).toBe(0);
    expect(harness.hostBoundsReads).toEqual({ container: 0, owner: 0 });
  }
  expect(harness.scrollWrites).toBe(0);
  expect(harness.layoutWrites).toBe(0);
  expect(harness.workReads).toEqual({ page: 0, scrollHeight: 0 });
  expect(harness.frames.maxPending).toBe(1);
  harness.navigation.cancelNavigation();
  harness.resetWrites();
  harness.frames.advanceQuiet(1_000);
  expect(harness.frames.pending).toBe(0);
  expect(harness.frames.pendingTimers).toBe(0);
  expectNoNavigationWrites(harness);
  expect(harness.layoutReads).toBe(0);
  expect(harness.hostBoundsReads).toEqual({ container: 0, owner: 0 });
  harness.navigation.dispose();
});

function expectMeasuredScrollNoOp(
  harness: ReturnType<typeof createNavigationHarness>,
  queueInput: () => void,
): void {
  harness.resetWrites();
  runInteractionFrames(() => {
    queueInput();
    harness.frames.flush();
  });
  expect(harness.scrollReads).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
  expect(harness.scrollWrites).toBe(0);
  expect(harness.layoutWrites).toBe(0);
  expect(harness.hostBoundsReads).toEqual({
    container: INTERACTION_REFRESH_PROFILE.sampleCount,
    owner: INTERACTION_REFRESH_PROFILE.sampleCount,
  });
}

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

function disposeActiveNavigation(harness: ReturnType<typeof createNavigationHarness>): void {
  expect(harness.activity).toEqual([true]);
  expect(harness.frames.maxTimers).toBeLessThanOrEqual(1);
  harness.navigation.dispose();
  expect(harness.activity).toEqual([true, false]);
  expect(harness.frames.pendingTimers).toBe(0);
}
