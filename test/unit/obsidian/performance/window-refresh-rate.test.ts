import { describe, expect, it, vi } from "vitest";

import type { RefreshRatePreferenceV2 } from "../../../../src/domain/settings";
import {
  detectRefreshRate,
  refreshRateProfile,
  WindowRefreshRateProfiles,
} from "../../../../src/obsidian/performance";

interface WindowHarness {
  readonly ownerDocument: Document;
  readonly ownerWindow: Window;
  readonly pendingFrames: () => number;
  readonly setHidden: (hidden: boolean) => void;
  readonly step: (timestamp: number) => void;
}

function windowHarness(hidden = false): WindowHarness {
  let visibilityState: DocumentVisibilityState = hidden ? "hidden" : "visible";
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const visibilityListeners = new Set<EventListenerOrEventListenerObject>();
  const document = {
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === "visibilitychange") visibilityListeners.add(listener);
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === "visibilitychange") visibilityListeners.delete(listener);
    },
    get visibilityState() {
      return visibilityState;
    },
  } as unknown as Document;
  const ownerWindow = {
    cancelAnimationFrame: (frame: number) => frames.delete(frame),
    document,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const frame = ++nextFrame;
      frames.set(frame, callback);
      return frame;
    },
  } as unknown as Window;
  return {
    ownerDocument: document,
    ownerWindow,
    pendingFrames: () => frames.size,
    setHidden: (hiddenValue) => {
      visibilityState = hiddenValue ? "hidden" : "visible";
      for (const listener of visibilityListeners) {
        if (typeof listener === "function") listener(new Event("visibilitychange"));
        else listener.handleEvent(new Event("visibilitychange"));
      }
    },
    step: (timestamp) => {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(timestamp);
    },
  };
}

function completeMeasurement(harness: WindowHarness, intervalMs: number): void {
  for (let index = 0; index <= 18; index += 1) harness.step(index * intervalMs);
}

function acquiredProfiles(preference: RefreshRatePreferenceV2 = "auto", hidden = false) {
  const harness = windowHarness(hidden);
  const profiles = new WindowRefreshRateProfiles(preference);
  const release = profiles.acquire(harness.ownerWindow, harness.ownerDocument);
  return { harness, profiles, release };
}

function completeScheduledMeasurement(
  harness: WindowHarness,
  profiles: WindowRefreshRateProfiles,
  refreshRate: 60 | 90 | 120 | 144 | 240,
): void {
  expect(harness.pendingFrames()).toBe(1);
  completeMeasurement(harness, 1_000 / refreshRate);
  expect(profiles.profile(harness.ownerWindow).refreshRate).toBe(refreshRate);
  expect(harness.pendingFrames()).toBe(0);
}

describe("refresh-rate profiles", () => {
  it.each([
    [60, 16.67],
    [90, 11.11],
    [120, 8.33],
    [144, 6.94],
    [240, 4.17],
  ] as const)("reserves 55 percent of the %i Hz frame", (rate, frameDuration) => {
    const profile = refreshRateProfile(rate);

    expect(profile.frameDurationMs).toBeCloseTo(frameDuration, 2);
    expect(profile.sliceBudgetMs).toBeCloseTo(profile.frameDurationMs * 0.55, 6);
  });

  it("classifies jitter and dropped frames conservatively", () => {
    expect(detectRefreshRate([8.2, 8.4, 16.7, 8.3, 8.5, 25, 8.3, 8.4])).toBe(120);
    expect(detectRefreshRate([6.8, 6.9, 13.8, 7, 6.95, 20.8])).toBe(144);
    expect(detectRefreshRate([])).toBe(120);
  });
});

describe("per-window automatic refresh-rate measurement", () => {
  it("uses the 120 Hz profile until one startup measurement completes", () => {
    const { harness, profiles, release } = acquiredProfiles();

    expect(profiles.profile(harness.ownerWindow).refreshRate).toBe(120);
    expect(profiles.status(harness.ownerWindow)).toEqual({
      kind: "detecting",
      refreshRate: 120,
    });
    completeMeasurement(harness, 1_000 / 120);

    expect(profiles.profile(harness.ownerWindow).refreshRate).toBe(120);
    expect(profiles.status(harness.ownerWindow)).toEqual({
      kind: "detected",
      refreshRate: 120,
    });
    expect(harness.pendingFrames()).toBe(0);

    harness.setHidden(true);
    harness.setHidden(false);
    expect(harness.pendingFrames()).toBe(0);

    release();
    profiles.acquire(harness.ownerWindow, harness.ownerDocument);
    expect(profiles.profile(harness.ownerWindow).refreshRate).toBe(120);
    expect(harness.pendingFrames()).toBe(0);
  });

  it("waits for a hidden window to become visible and then measures once", () => {
    const { harness, profiles } = acquiredProfiles("auto", true);

    expect(harness.pendingFrames()).toBe(0);
    harness.setHidden(false);
    expect(harness.pendingFrames()).toBe(1);

    completeMeasurement(harness, 1_000 / 90);
    expect(profiles.profile(harness.ownerWindow).refreshRate).toBe(90);
    harness.setHidden(true);
    harness.setHidden(false);
    expect(harness.pendingFrames()).toBe(0);
  });

  it("restarts one incomplete startup measurement after the owning window becomes visible", () => {
    const { harness, profiles } = acquiredProfiles();

    harness.step(0);
    harness.step(1_000 / 60);
    harness.setHidden(true);
    expect(harness.pendingFrames()).toBe(0);

    harness.setHidden(false);
    completeScheduledMeasurement(harness, profiles, 144);
  });

  it("publishes detecting and detected status changes once per measurement", () => {
    const harness = windowHarness();
    const changed = vi.fn();
    const profiles = new WindowRefreshRateProfiles("auto", changed);
    profiles.acquire(harness.ownerWindow, harness.ownerDocument);

    expect(profiles.status(harness.ownerWindow).kind).toBe("detecting");
    completeMeasurement(harness, 1_000 / 144);

    expect(changed).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledWith(harness.ownerWindow);
    expect(profiles.status(harness.ownerWindow)).toEqual({
      kind: "detected",
      refreshRate: 144,
    });
  });
});

describe("refresh-rate profile lifecycle", () => {
  it("measures pop-out windows independently and releases their animation work", () => {
    const first = windowHarness();
    const second = windowHarness();
    const profiles = new WindowRefreshRateProfiles("auto");
    const releaseFirst = profiles.acquire(first.ownerWindow, first.ownerDocument);
    profiles.acquire(second.ownerWindow, second.ownerDocument);

    completeMeasurement(first, 1_000 / 60);
    completeMeasurement(second, 1_000 / 144);
    expect(profiles.profile(first.ownerWindow).refreshRate).toBe(60);
    expect(profiles.profile(second.ownerWindow).refreshRate).toBe(144);

    releaseFirst();
    expect(profiles.profile(first.ownerWindow).refreshRate).toBe(60);
  });

  it("does not start automatic measurement for a fixed profile", () => {
    const { harness, profiles } = acquiredProfiles(240);

    expect(profiles.profile(harness.ownerWindow).refreshRate).toBe(240);
    expect(profiles.status(harness.ownerWindow)).toEqual({ kind: "fixed", refreshRate: 240 });
    expect(harness.pendingFrames()).toBe(0);
  });

  it("measures once when fixed mode changes to Auto and cancels when Auto changes to fixed", () => {
    const { harness, profiles } = acquiredProfiles(120);
    expect(harness.pendingFrames()).toBe(0);

    profiles.setPreference("auto");
    completeScheduledMeasurement(harness, profiles, 144);

    profiles.setPreference(90);
    expect(harness.pendingFrames()).toBe(0);
    profiles.setPreference("auto");
    expect(harness.pendingFrames()).toBe(1);
    profiles.setPreference(60);
    expect(harness.pendingFrames()).toBe(0);
    expect(profiles.profile(harness.ownerWindow).refreshRate).toBe(60);
  });
});
