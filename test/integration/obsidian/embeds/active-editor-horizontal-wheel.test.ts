import { describe, expect, it } from "vitest";

import { createInputState } from "../../../../src/editor/input/index";
import { OUTER_PAGE_WIDTH } from "../../../../src/editor/zoom/zoom";
import {
  ActiveEditorNavigation,
  type ActiveEditorWheelInput,
} from "../../../../src/obsidian/embeds/active-editor/navigation";
import {
  buildNavigationHarness,
  startNavigationFlick,
} from "../../../fixtures/obsidian/navigation-refresh-profile";

function createHarness(aboveFit = true) {
  const harness = buildNavigationHarness(
    { ActiveEditorNavigation, createInputState, OUTER_PAGE_WIDTH },
    125,
  );
  if (aboveFit) harness.navigation.restoreViewState({ cameraX: -200, zoom: 1 });
  harness.resetWrites();
  return harness;
}

function wheel(overrides: Partial<ActiveEditorWheelInput> = {}): ActiveEditorWheelInput {
  return {
    clientX: 500,
    clientY: 300,
    ctrlKey: false,
    deltaMode: 0,
    deltaX: 8,
    deltaY: 0,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  };
}

function publishWheel(
  harness: ReturnType<typeof createHarness>,
  deltaX: number,
  overrides: Partial<ActiveEditorWheelInput> = {},
): void {
  expect(harness.navigation.updateWheel(wheel({ deltaX, ...overrides }))).toBe(true);
  expect(harness.frames.pending).toBe(1);
  harness.frames.flush();
}

describe("active editor horizontal wheel input", () => {
  it.each([0.125, 2, 20, 80, -0.125, -2, -20, -80])(
    "applies pixel delta %s directly in screen space",
    (deltaX) => {
      const harness = createHarness();

      expect(harness.navigation.updateWheel(wheel({ deltaX }))).toBe(true);
      expect(harness.navigation.cameraX).toBe(-200);
      expect(harness.frames.pending).toBe(1);
      expect(harness.hostBoundsReads).toEqual({ container: 0, owner: 0 });
      harness.frames.flush();

      expect(harness.navigation.cameraX).toBeCloseTo(-200 - deltaX);
      expect(harness.cameraWrites).toBe(1);
      expect(harness.frames.pending).toBe(1);
      expect(harness.scrollWrites).toBe(0);
      expect(harness.layoutWrites).toBe(0);
      expect(harness.workReads).toEqual({ page: 0, scrollHeight: 0 });
      harness.navigation.dispose();
    },
  );

  it.each([[80], [40, 40], [10, 10, 10, 10, 10, 10, 10, 10], [80, -100]])(
    "coalesces deltas %j algebraically without acceleration or replay",
    (...deltas: number[]) => {
      const harness = createHarness();
      for (const deltaX of deltas) {
        expect(harness.navigation.updateWheel(wheel({ deltaX }))).toBe(true);
        expect(harness.frames.pending).toBe(1);
      }
      harness.frames.flush();

      expect(harness.navigation.cameraX).toBe(-200 - deltas.reduce((sum, delta) => sum + delta, 0));
      expect(harness.cameraWrites).toBe(1);
      expect(harness.frames.pending).toBe(1);
      harness.navigation.dispose();
    },
  );

  it("keeps cadence gaps stationary and accepts the native inertia tail and reversal", () => {
    const harness = createHarness();
    for (let sample = 0; sample < 3; sample += 1) {
      publishWheel(harness, 8);
    }
    expect(harness.navigation.cameraX).toBe(-224);
    expect(harness.frames.pending).toBe(1);

    harness.frames.flush();
    harness.frames.flush();
    expect(harness.navigation.cameraX).toBe(-224);
    expect(harness.cameraWrites).toBe(3);
    expect(harness.frames.pending).toBe(1);
    expect(harness.hostBoundsReads).toEqual({ container: 3, owner: 3 });

    publishWheel(harness, 2, { cancelable: false });
    expect(harness.navigation.cameraX).toBe(-226);
    harness.frames.advanceQuiet(40);
    publishWheel(harness, -2);
    expect(harness.navigation.cameraX).toBe(-224);
    expect(harness.cameraWrites).toBe(5);
    expect(harness.frames.pending).toBe(0);
    expect(harness.scrollWrites).toBe(0);
    harness.navigation.dispose();
  });
});

describe("horizontal wheel release", () => {
  it("estimates batched movement from event timestamps and releases only after quiet", () => {
    const harness = createHarness();
    harness.frames.advanceQuiet(24);
    for (const timeStamp of [1_000, 1_008, 1_016]) {
      expect(harness.navigation.updateWheel(wheel({ timeStamp }))).toBe(true);
    }
    harness.frames.flush();
    expect(harness.navigation.cameraX).toBe(-224);
    harness.resetWrites();
    harness.frames.flush();
    harness.frames.flush();
    expect(harness.navigation.cameraX).toBe(-224);
    expect(harness.hostBoundsReads).toEqual({ container: 0, owner: 0 });
    expect(harness.cameraWrites).toBe(0);
    harness.frames.flush();
    expect(harness.navigation.cameraX).toBeLessThan(-224);
    expect(harness.cameraWrites).toBe(1);
    expect(harness.frames.maxPending).toBe(1);
    expect(harness.scrollWrites).toBe(0);
    harness.navigation.dispose();
  });

  it("cancels an active tail before applying incoming native wheel displacement", () => {
    const harness = createHarness();
    for (let sample = 0; sample < 3; sample += 1) publishWheel(harness, 8);
    while (harness.frames.now < 1_056) harness.frames.flush();
    expect(harness.navigation.cameraX).toBeLessThan(-224);
    const previous = harness.navigation.cameraX;

    publishWheel(harness, -2, { cancelable: false });

    expect(harness.navigation.cameraX).toBe(previous + 2);
    expect(harness.frames.pending).toBe(0);
    expect(harness.scrollWrites).toBe(0);
    harness.navigation.dispose();
  });
});

describe("horizontal wheel routing and lifecycle", () => {
  it.each([
    { deltaMode: 1, deltaX: 3, expected: 48 },
    { deltaMode: 2, deltaX: 0.1, expected: 50 },
    { deltaMode: 1, deltaX: 0, deltaY: 2, shiftKey: true, expected: 32 },
    { deltaMode: 2, deltaX: 0, deltaY: 0.2, shiftKey: true, expected: 100 },
  ])("normalizes line/page and Shift-wheel input: %j", ({ expected, ...input }) => {
    const harness = createHarness();
    expect(harness.navigation.updateWheel(wheel(input))).toBe(true);
    harness.frames.flush();

    expect(harness.navigation.cameraX).toBeCloseTo(-200 - expected);
    expect(harness.frames.pending).toBe(0);
    expect(harness.scrollWrites).toBe(0);
    harness.navigation.dispose();
  });

  it.each([
    { deltaX: 0, deltaY: 20 },
    { deltaX: 2, deltaY: 20 },
    { deltaX: 20, deltaY: 20 },
    { deltaX: 1, deltaY: 2, shiftKey: true },
    { deltaX: 0, deltaY: 0 },
    { deltaX: Number.NaN },
    { deltaY: Number.POSITIVE_INFINITY },
  ])("leaves vertical, ambiguous, empty and invalid input unclaimed: %j", (input) => {
    const harness = createHarness();

    expect(harness.navigation.updateWheel(wheel(input))).toBe(false);
    expect(harness.navigation.cameraX).toBe(-200);
    expect(harness.cameraWrites).toBe(0);
    expect(harness.scrollWrites).toBe(0);
    expect(harness.frames.pending).toBe(0);
    harness.navigation.dispose();
  });

  it("leaves horizontal input unclaimed at width fit", () => {
    const harness = createHarness(false);

    expect(harness.navigation.updateWheel(wheel())).toBe(false);
    expect(harness.navigation.cameraX).toBe(0);
    expect(harness.frames.pending).toBe(0);
    expect(harness.cameraWrites).toBe(0);
    harness.navigation.dispose();
  });

  it("clamps at a page boundary and reverses on the next direct sample", () => {
    const harness = createHarness();

    publishWheel(harness, -Number.MAX_VALUE);
    expect(harness.navigation.cameraX).toBe(0);
    publishWheel(harness, -2);
    expect(harness.frames.pending).toBe(0);
    publishWheel(harness, 2);
    expect(harness.navigation.cameraX).toBe(-2);
    expect(harness.frames.pending).toBe(1);
    harness.navigation.dispose();
  });
});

describe("horizontal wheel momentum lifecycle", () => {
  it("cancels touch momentum when vertical wheel input returns to the host", () => {
    const harness = createHarness();
    startNavigationFlick(harness, -1);
    expect(harness.frames.pending).toBe(1);

    expect(harness.navigation.updateWheel(wheel({ deltaX: 0, deltaY: 8 }))).toBe(false);
    expect(harness.frames.pending).toBe(0);
    expect(harness.navigation.cameraX).toBe(-200);
    expect(harness.scrollWrites).toBe(0);
    harness.navigation.dispose();
  });

  it.each([
    { deltaX: 0, deltaY: 8 },
    { ctrlKey: true, deltaY: 0 },
    { deltaX: 0, deltaY: 8, shiftKey: true },
    { deltaMode: 1 },
    { deltaMode: 2 },
  ])("cancels trackpad release on conflicting Wheel input: %j", (input) => {
    const harness = createHarness();
    publishWheel(harness, 8);
    publishWheel(harness, 8);
    expect(harness.frames.pending).toBe(1);
    harness.navigation.updateWheel(wheel(input));
    if (harness.frames.pending !== 0) harness.frames.flush();
    expect(harness.frames.pending).toBe(0);
    const camera = harness.navigation.cameraX;
    harness.frames.advanceQuiet(120);
    expect(harness.navigation.cameraX).toBe(camera);
    expect(harness.scrollWrites).toBe(0);
    harness.navigation.dispose();
  });

  it("cancels pending quiet frames on pointer arbitration, resize, owner transfer and disposal", () => {
    const harness = createHarness();
    const arm = () => {
      publishWheel(harness, 8);
      publishWheel(harness, 8);
      expect(harness.frames.pending).toBe(1);
    };
    arm();
    harness.navigation.beginGestureGeometry();
    expect(harness.frames.pending).toBe(0);
    arm();
    harness.navigation.applyResize({ cameraX: -200, fitZoom: 0.5, zoom: 1 });
    expect(harness.frames.pending).toBe(0);
    arm();
    harness.navigation.transferScrollOwner({ ...harness.owner });
    expect(harness.frames.pending).toBe(0);
    arm();
    harness.navigation.dispose();
    expect(harness.frames.pending).toBe(0);
    expect(harness.frames.pendingTimers).toBe(0);
  });

  it("releases a pending wheel frame and activity timer on disposal", () => {
    const harness = createHarness();
    harness.navigation.updateWheel(wheel());
    expect(harness.frames.pending).toBe(1);

    harness.navigation.dispose();

    expect(harness.frames.pending).toBe(0);
    expect(harness.frames.pendingTimers).toBe(0);
    expect(harness.navigation.cameraX).toBe(-200);
    expect(harness.cameraWrites).toBe(0);
  });
});
