import { describe, expect, it } from "vitest";

import { WorkspaceRefreshProfiles } from "../../../../src/obsidian/embeds/workspace-refresh-profiles";
import { ManualHost } from "../../../fixtures/scheduling/manual-frame-host";

function owningWindow() {
  const host = new ManualHost();
  const events = new EventTarget();
  const ownerWindow = Object.assign(events, {
    document: { visibilityState: "visible" },
    performance: { now: host.now },
    requestAnimationFrame: host.requestFrame,
    cancelAnimationFrame: host.cancelFrame,
    setTimeout: host.setTimer,
    clearTimeout: host.clearTimer,
  }) as unknown as Window;
  return { host, ownerWindow };
}

describe("workspace scheduler ownership", () => {
  it("shares one window budget and applies settings without renewing consumed time", () => {
    const profiles = new WorkspaceRefreshProfiles(120);
    const { host, ownerWindow } = owningWindow();
    profiles.observeDefault(ownerWindow);
    const first = profiles.workScheduler(ownerWindow);
    expect(profiles.workScheduler(null)).toBe(first);
    expect(first.deadline()).toBeCloseTo((1_000 / 120) * 0.55);
    host.time = 3;
    profiles.setPreference(240);
    expect(first.shouldYield()).toBe(true);
    expect(first.deadline()).toBeCloseTo((1_000 / 240) * 0.55);
    expect(profiles.workScheduler(ownerWindow)).toBe(first);
    profiles.dispose();
    expect(host.pendingFrames).toBe(0);
    expect(host.pendingTimers).toBe(0);
  });

  it("separates windows and settles cancelled work when its window unloads", async () => {
    const profiles = new WorkspaceRefreshProfiles(120);
    const firstWindow = owningWindow();
    const secondWindow = owningWindow();
    const first = profiles.workScheduler(firstWindow.ownerWindow);
    const second = profiles.workScheduler(secondWindow.ownerWindow);
    expect(first).not.toBe(second);
    const cancelled = expect(first.nextFrame()).rejects.toThrow("disposed");
    const completed = second.nextFrame();
    firstWindow.ownerWindow.dispatchEvent(new Event("unload"));
    await cancelled;
    expect(firstWindow.host.pendingFrames).toBe(0);
    expect(firstWindow.host.pendingTimers).toBe(0);
    secondWindow.host.frame();
    await completed;
    profiles.dispose();
    expect(secondWindow.host.pendingTimers).toBe(0);
  });

  it("requires an owner and cancels scheduled work on workspace disposal", async () => {
    const profiles = new WorkspaceRefreshProfiles(120);
    expect(() => profiles.workScheduler(null)).toThrow("owning window");
    const { host, ownerWindow } = owningWindow();
    const scheduler = profiles.workScheduler(ownerWindow);
    const cancelled = expect(scheduler.nextFrame()).rejects.toThrow("disposed");
    profiles.dispose();
    await cancelled;
    expect(() => profiles.workScheduler(ownerWindow)).toThrow("disposed");
    profiles.dispose();
    expect(host.pendingFrames).toBe(0);
    expect(host.pendingTimers).toBe(0);
  });

  it("invalidates ownership only for default, presentation and unload transitions", () => {
    const profiles = new WorkspaceRefreshProfiles(120);
    const first = owningWindow();
    const second = owningWindow();
    expect(profiles.ownerWindowVersion()).toBe(0);
    profiles.observeDefault(first.ownerWindow);
    expect(profiles.ownerWindowVersion()).toBe(1);
    profiles.observeDefault(first.ownerWindow);
    profiles.setPreference(240);
    expect(profiles.ownerWindowVersion()).toBe(1);
    profiles.notifyOwnerWindowChanged();
    expect(profiles.ownerWindowVersion()).toBe(2);
    profiles.observeDefault(second.ownerWindow);
    expect(profiles.ownerWindowVersion()).toBe(3);
    profiles.workScheduler(first.ownerWindow);
    first.ownerWindow.dispatchEvent(new Event("unload"));
    expect(profiles.ownerWindowVersion()).toBe(4);
    expect(profiles.isWindowAvailable(first.ownerWindow)).toBe(false);
    expect(profiles.isWindowAvailable(second.ownerWindow)).toBe(true);
    expect(() => profiles.workScheduler(first.ownerWindow)).toThrow("unloaded");
    profiles.dispose();
  });
});
