// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import {
  createPhoneSheetSwipeHarness,
  touchPointer,
} from "../../../fixtures/obsidian/phone-sheet-swipe";

describe("PhoneSheetSwipeController", () => {
  beforeEach(() => {
    installObsidianDomHelpers();
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("caches sheet height and coalesces drag writes to the latest frame", () => {
    const fixture = createPhoneSheetSwipeHarness();
    const { frames } = fixture;
    const heightRead = vi.spyOn(fixture.surface, "getBoundingClientRect");

    beginTouchDrag(fixture, 20, 10);
    fixture.surface.dispatchEvent(touchPointer("pointermove", 60, 1, 20));
    fixture.surface.dispatchEvent(touchPointer("pointermove", 90, 1, 30));

    expect(heightRead).toHaveBeenCalledOnce();
    expect(frames.pending).toBe(1);
    expect(fixture.surface.style.getPropertyValue("--inkbook-adaptive-panel-drag")).toBe("");

    frames.flush();

    expect(fixture.surface.style.getPropertyValue("--inkbook-adaptive-panel-drag")).toBe("80px");
    expect(
      fixture.backdrop.style.getPropertyValue("--inkbook-adaptive-panel-backdrop-opacity"),
    ).toBe("0.6");
    expect(heightRead).toHaveBeenCalledOnce();
  });

  it("settles after a pending drag frame without reading layout on pointerup", () => {
    vi.useFakeTimers();
    const fixture = createPhoneSheetSwipeHarness(300);
    const { frames } = fixture;
    const heightRead = vi.spyOn(fixture.surface, "getBoundingClientRect");

    beginTouchDrag(fixture, 50, 100);
    fixture.surface.dispatchEvent(touchPointer("pointerup", 50, 1, 300));

    expect(fixture.close).not.toHaveBeenCalled();
    expect(heightRead).toHaveBeenCalledOnce();
    expect(fixture.surface.dataset.swipeState).toBe("settling");
    expect(frames.pending).toBe(1);
    expect(fixture.surface.style.getPropertyValue("--inkbook-adaptive-panel-drag")).toBe("40px");

    frames.flush();
    expect(fixture.surface.style.getPropertyValue("--inkbook-adaptive-panel-drag")).toBe("");
    vi.runAllTimers();

    expect(fixture.surface.dataset.swipeState).toBeUndefined();
    expect(fixture.backdrop.dataset.swipeState).toBeUndefined();
    expect(heightRead).toHaveBeenCalledOnce();
  });

  it("cancels queued drag writes when the gesture or controller is closed", () => {
    const fixture = createPhoneSheetSwipeHarness(300);
    const { controller, frames } = fixture;

    beginTouchDrag(fixture, 50, 10);
    controller.prepareClose();
    expect(frames.pending).toBe(0);
    expect(fixture.surface.style.getPropertyValue("--inkbook-adaptive-panel-drag")).toBe("");

    fixture.handle.dispatchEvent(touchPointer("pointerdown", 10, 2, 20));
    fixture.surface.dispatchEvent(touchPointer("pointermove", 50, 2, 30));
    controller.dispose();
    expect(frames.pending).toBe(0);
    expect(fixture.surface.dataset.scrollPosition).toBeUndefined();
  });
});

function beginTouchDrag(
  fixture: ReturnType<typeof createPhoneSheetSwipeHarness>,
  clientY: number,
  timeStamp: number,
): void {
  fixture.handle.dispatchEvent(touchPointer("pointerdown", 10, 1, 0));
  fixture.surface.dispatchEvent(touchPointer("pointermove", clientY, 1, timeStamp));
}

describe("PhoneSheetSwipeController scroll state", () => {
  it("updates scroll state only when the top boundary changes", () => {
    const fixture = createPhoneSheetSwipeHarness();
    const { controller } = fixture;
    const mutations: string[] = [];
    const observer = new MutationObserver((records) => {
      mutations.push(...records.map((record) => record.attributeName ?? ""));
    });
    observer.observe(fixture.surface, { attributes: true });

    controller.syncScrollPosition();
    fixture.scroll.scrollTop = 20;
    controller.syncScrollPosition();
    controller.syncScrollPosition();
    observer.takeRecords().forEach((record) => mutations.push(record.attributeName ?? ""));

    expect(mutations.filter((name) => name === "data-scroll-position")).toHaveLength(1);
    observer.disconnect();
    controller.dispose();
  });
});
