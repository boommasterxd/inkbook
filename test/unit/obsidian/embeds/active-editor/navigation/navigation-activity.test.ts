import { afterEach, describe, expect, it, vi } from "vitest";
import { NavigationActivity } from "../../../../../../src/obsidian/embeds/active-editor/navigation/navigation-activity";

function createHarness() {
  vi.useFakeTimers();
  const onActive = vi.fn();
  const owner = { setTimeout, clearTimeout } as unknown as Window;
  return { activity: new NavigationActivity(owner, onActive), onActive };
}

afterEach(() => vi.useRealTimers());

describe("navigation activity", () => {
  it("extends native wheel activity without creating multiple timers or duplicate transitions", () => {
    const { activity, onActive } = createHarness();
    activity.pulse();
    vi.advanceTimersByTime(100);
    activity.pulse();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(119);
    expect(onActive.mock.calls).toEqual([[true]]);
    vi.advanceTimersByTime(1);
    expect(onActive.mock.calls).toEqual([[true], [false]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds across delayed camera frames and momentum then waits for quiet", () => {
    const { activity, onActive } = createHarness();
    activity.pulse();
    activity.hold();
    activity.pulse();
    vi.advanceTimersByTime(1_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(onActive.mock.calls).toEqual([[true]]);
    activity.settle();
    vi.advanceTimersByTime(100);
    activity.hold();
    activity.settle();
    vi.advanceTimersByTime(120);
    expect(onActive.mock.calls).toEqual([[true], [false]]);
  });

  it("releases once on reset and cancels the old window timer before transfer", () => {
    const { activity, onActive } = createHarness();
    const schedule = vi.fn(setTimeout);
    const nextWindow = { setTimeout: schedule, clearTimeout } as unknown as Window;
    activity.pulse();
    activity.transfer(nextWindow);
    activity.reset();
    expect(vi.getTimerCount()).toBe(0);
    expect(onActive.mock.calls).toEqual([[true], [false]]);
    activity.pulse();
    expect(schedule).toHaveBeenCalledOnce();
    activity.reset();
    vi.runAllTimers();
    expect(onActive.mock.calls).toEqual([[true], [false], [true], [false]]);
  });

  it("does not schedule background-priority work without a subscriber", () => {
    vi.useFakeTimers();
    const activity = new NavigationActivity({} as Window);
    activity.pulse();
    activity.hold();
    activity.settle();
    activity.reset();
    expect(vi.getTimerCount()).toBe(0);
  });
});
