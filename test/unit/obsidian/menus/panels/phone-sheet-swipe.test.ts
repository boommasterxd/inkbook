// @vitest-environment happy-dom
import "../../../../fixtures/obsidian/menu-motion";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";
import {
  createPhoneSheetSwipeHarness,
  touchPointer,
} from "../../../../fixtures/obsidian/phone-sheet-swipe";

beforeEach(() => {
  installObsidianDomHelpers();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("phone sheet swipe fixture restoration", () => {
  it.for([false, true])("restores plain performance overrides after failure=%s", (fail) => {
    const request = Object.getOwnPropertyDescriptor(window, "requestAnimationFrame");
    const cancel = Object.getOwnPropertyDescriptor(window, "cancelAnimationFrame");
    const originalSetProperty = Object.getOwnPropertyDescriptor(
      window.createDiv().style,
      "setProperty",
    );
    const fixture = createPhoneSheetSwipeHarness(0, false);
    let caught: unknown;
    try {
      beginTouchDrag(fixture, 20, 10);
      fixture.surface.dispatchEvent(touchPointer("pointermove", 60, 1, 20));
      expect(fixture.frames.pending).toBe(1);
      if (fail) throw new Error("Injected failure");
      fixture.frames.flush();
      expect(fixture.dragWrites).toBe(1);
    } catch (error) {
      caught = error;
    } finally {
      try {
        fixture.controller.dispose();
      } finally {
        fixture.restore();
      }
    }
    if (fail) expect(caught).toEqual(new Error("Injected failure"));
    else expect(caught).toBeUndefined();
    expect(fixture.frames.pending).toBe(0);
    expect(Object.getOwnPropertyDescriptor(window, "requestAnimationFrame")).toEqual(request);
    expect(Object.getOwnPropertyDescriptor(window, "cancelAnimationFrame")).toEqual(cancel);
    expect(Object.getOwnPropertyDescriptor(fixture.surface.style, "setProperty")).toEqual(
      originalSetProperty,
    );
    fixture.restore();
    expect(Object.getOwnPropertyDescriptor(fixture.surface.style, "setProperty")).toEqual(
      originalSetProperty,
    );
  });
});

describe("PhoneSheetSwipeController", () => {
  it("caches sheet height and coalesces drag writes to the latest frame", () => {
    const fixture = createPhoneSheetSwipeHarness();
    const { frames } = fixture;
    const heightRead = vi.spyOn(fixture.surface, "getBoundingClientRect");

    beginTouchDrag(fixture, 20, 10);
    fixture.surface.dispatchEvent(touchPointer("pointermove", 60, 1, 20));
    fixture.surface.dispatchEvent(touchPointer("pointermove", 90, 1, 30));

    expect(heightRead).toHaveBeenCalledOnce();
    expect(fixture.surface.style.getPropertyValue("--inkbook-adaptive-panel-drag")).toBe("");
    expect(
      fixture.backdrop.style.getPropertyValue("--inkbook-adaptive-panel-backdrop-opacity"),
    ).toBe("");
    expect(frames.pending).toBe(1);
    expect(fixture.scheduleFrame).toHaveBeenCalledWith(expect.any(Function), "input");
    expect(fixture.surface.style.getPropertyValue("translate")).toBe("");

    frames.flush();

    expect(fixture.surface.style.getPropertyValue("translate")).toBe("0 80px");
    expect(fixture.backdrop.style.getPropertyValue("opacity")).toBe("0.6");
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
    expect(frames.pending).toBe(0);
    expect(fixture.surface.style.getPropertyValue("translate")).toBe("0 40px");

    vi.runAllTimers();

    expect(fixture.surface.style.getPropertyValue("translate")).toBe("");
    expect(fixture.surface.dataset.swipeState).toBeUndefined();
    expect(fixture.backdrop.dataset.swipeState).toBeUndefined();
    expect(heightRead).toHaveBeenCalledOnce();
  });

  it("flushes the last drag before close and clears presentation on disposal", () => {
    const fixture = createPhoneSheetSwipeHarness(300);
    const { controller, frames } = fixture;

    beginTouchDrag(fixture, 50, 10);
    controller.prepareClose();
    expect(frames.pending).toBe(0);
    expect(fixture.surface.style.getPropertyValue("--inkbook-adaptive-panel-drag")).toBe("40px");

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

describe("PhoneSheetSwipeController interruption continuity", () => {
  it("snapshots the visible return transition exactly once for an external close", () => {
    const fixture = createPhoneSheetSwipeHarness(220);
    beginTouchDrag(fixture, 70, 100);
    fixture.surface.dispatchEvent(touchPointer("pointerup", 70, 1, 400));
    const computed = vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element) =>
        ({
          translate: element === fixture.surface ? "0px 25px" : "none",
          opacity: "0.875",
        }) as CSSStyleDeclaration,
    );
    fixture.controller.prepareClose();
    expect(fixture.surface.style.translate).toBe("");
    expect(fixture.backdrop.style.opacity).toBe("");
    expect(fixture.surface.style.getPropertyValue("--inkbook-adaptive-panel-drag")).toBe("25px");
    expect(
      fixture.backdrop.style.getPropertyValue("--inkbook-adaptive-panel-backdrop-opacity"),
    ).toBe("0.875");
    expect(computed).toHaveBeenCalledTimes(2);
    fixture.controller.dispose();
    expect(computed).toHaveBeenCalledTimes(2);
    expect(fixture.surface.style.getPropertyValue("--inkbook-adaptive-panel-drag")).toBe("");
  });

  it("dismisses from the final pointerup position even before the pending frame", () => {
    const fixture = createPhoneSheetSwipeHarness(220);
    fixture.close.mockImplementation(() => fixture.controller.prepareClose());
    beginTouchDrag(fixture, 50, 100);
    fixture.surface.dispatchEvent(touchPointer("pointerup", 140, 1, 400));
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.surface.style.getPropertyValue("--inkbook-adaptive-panel-drag")).toBe("130px");
    expect(fixture.frames.pending).toBe(0);
    fixture.controller.dispose();
  });

  it.each(["settling", "entering"])("regrabs the visible %s position without jumping", (state) => {
    const fixture = createPhoneSheetSwipeHarness(220);
    if (state === "settling") {
      beginTouchDrag(fixture, 70, 100);
      fixture.surface.dispatchEvent(touchPointer("pointerup", 70, 1, 400));
    } else fixture.surface.dataset.presence = "entering";
    const computed = vi
      .spyOn(window, "getComputedStyle")
      .mockReturnValue({ translate: "0px 20%" } as CSSStyleDeclaration);
    fixture.handle.dispatchEvent(touchPointer("pointerdown", 100, 2, 500));
    expect(fixture.surface.style.getPropertyValue("translate")).toBe("0 40px");
    expect(fixture.surface.dataset.presence).toBeUndefined();
    fixture.surface.dispatchEvent(touchPointer("pointermove", 115, 2, 550));
    fixture.frames.flush();
    expect(fixture.surface.style.getPropertyValue("translate")).toBe("0 55px");
    expect(computed).toHaveBeenCalledOnce();
    fixture.surface.dispatchEvent(touchPointer("pointerup", 120, 2, 700));
    expect(fixture.close).not.toHaveBeenCalled();
    expect(fixture.surface.style.getPropertyValue("translate")).toBe("0 60px");
    fixture.controller.dispose();
    expect(fixture.frames.pending).toBe(0);
  });
});

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
