// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";

import type { AdaptivePanelContentLifecycle } from "../../../../src/obsidian/menus/adaptive-panel";

import { createHtmlElement, installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { createAdaptivePanelFixture as createFixture } from "../../../adapters/obsidian/adaptive-panel";

beforeEach(() => {
  installObsidianDomHelpers();
  Platform.isMobile = false;
  Platform.isPhone = false;
});

afterEach(() => {
  Platform.isMobile = false;
  Platform.isPhone = false;
  Reflect.deleteProperty(window, "visualViewport");
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("AdaptivePanelSession wide lifecycle", () => {
  it("owns a wide panel without mutating native Obsidian menu DOM", () => {
    const fixture = createFixture("style");

    expect(
      document.querySelector(".inkbook-adaptive-panel-layer")?.getAttribute("data-platform"),
    ).toBe("wide");
    expect(document.querySelector(".inkbook-adaptive-panel")?.getAttribute("data-kind")).toBe(
      "style",
    );
    expect(document.querySelector(".menu")).toBeNull();
    expect(document.querySelector(".menu-scroll")).toBeNull();
    expect(fixture.keymap.scopes).toHaveLength(1);

    fixture.session.close("immediate");

    expect(document.querySelector(".inkbook-adaptive-panel-layer")).toBeNull();
    expect(fixture.keymap.scopes).toHaveLength(0);
    expect(fixture.anchorFocus).toHaveBeenCalledWith({ preventScroll: true });
    expect(fixture.onClosed).toHaveBeenCalledOnce();
  });

  it("marks a non-phone mobile surface for native tablet blur styling", () => {
    Platform.isMobile = true;

    const fixture = createFixture("style");
    const layer = document.querySelector<HTMLElement>(".inkbook-adaptive-panel-layer");

    expect(layer?.dataset.platform).toBe("wide");
    expect(layer?.dataset.mobile).toBe("true");
    expect(document.querySelector(".inkbook-adaptive-panel")?.hasAttribute("aria-modal")).toBe(
      false,
    );
    fixture.session.close("immediate");
  });

  it("keeps inside interaction open and dismisses on outside pointer or Escape", () => {
    const inside = createFixture("style");
    inside.control.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(document.querySelector(".inkbook-adaptive-panel")).not.toBeNull();

    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(document.querySelector(".inkbook-adaptive-panel")).toBeNull();
    expect(inside.onClosed).toHaveBeenCalledOnce();

    const escaped = createFixture("background");
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    expect(document.querySelector(".inkbook-adaptive-panel")).toBeNull();
    expect(escaped.onClosed).toHaveBeenCalledOnce();
  });
});

describe("AdaptivePanelSession wide positioning", () => {
  it("anchors below the trigger, clamps inline, and flips above near the viewport edge", () => {
    mockWidePanelGeometry(500);

    const fixture = createFixture("background", { anchorRect: rect(470, 700, 44, 44) });
    const surface = document.querySelector<HTMLElement>(".inkbook-adaptive-panel");

    expect(surface?.style.insetInlineStart).toBe("293px");
    expect(surface?.style.insetBlockStart).toBe("396px");
    fixture.session.close("immediate");
  });

  it("matches the native visible desktop gap while retaining tablet placement", () => {
    mockWidePanelGeometry(1000);

    const desktop = createFixture("background", { anchorRect: rect(300, 100, 44, 44) });
    expect(
      document.querySelector<HTMLElement>(".inkbook-adaptive-panel")?.style.insetBlockStart,
    ).toBe("148px");
    desktop.session.close("immediate");

    Platform.isMobile = true;
    const tablet = createFixture("background", { anchorRect: rect(300, 100, 44, 44) });
    expect(
      document.querySelector<HTMLElement>(".inkbook-adaptive-panel")?.style.insetBlockStart,
    ).toBe("146px");
    tablet.session.close("immediate");
  });
});

describe("AdaptivePanelSession wide keyboard behavior", () => {
  it("moves initial focus to the first interactive control", () => {
    const frames = mockAnimationFrames();
    const style = createFixture("style");
    frames.shift()?.(0);
    expect(document.activeElement).toBe(style.control);
    style.session.close("immediate");
    const background = createFixture("background", { onBack: vi.fn() });
    frames.shift()?.(16);
    expect(document.activeElement).toBe(
      document.querySelector<HTMLElement>(".inkbook-adaptive-panel-back"),
    );
    background.session.close("immediate");
  });

  it("renders Back as a keyboard-operable menu entry instead of a host button", () => {
    const onBack = vi.fn();
    const fixture = createFixture("background", { onBack });
    const back = document.querySelector<HTMLElement>(".inkbook-adaptive-panel-back");
    expect(back?.tagName).toBe("DIV");
    expect(back?.getAttribute("role")).toBe("button");
    expect(back?.tabIndex).toBe(0);
    back?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    back?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: " " }));
    expect(onBack).toHaveBeenCalledTimes(2);
    fixture.session.close("immediate");
  });

  it("cycles focus inside the panel and falls back to the canvas when the trigger detaches", () => {
    const fixture = createFixture("style");
    const second = createHtmlElement("button");
    second.textContent = "Second";
    document.querySelector(".inkbook-adaptive-panel-content")?.append(second);
    fixture.control.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }));
    expect(document.activeElement).toBe(second);
    fixture.anchor.remove();
    fixture.session.close("immediate");
    expect(fixture.canvasFocus).toHaveBeenCalledWith({ preventScroll: true });
  });
});

describe("AdaptivePanelSession phone lifecycle", () => {
  it("does not reposition or measure content for internal sheet scrolling", () => {
    Platform.isPhone = true;
    const frames = mockAnimationFrames();
    const fixture = createFixture("style");
    frames.shift()?.(0);
    const scroll = document.querySelector<HTMLElement>(".inkbook-adaptive-panel-scroll");
    scroll?.dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(frames).toHaveLength(0);
    const outside = createHtmlElement("div");
    document.body.append(outside);
    outside.dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(frames).toHaveLength(1);
    fixture.session.close("immediate");
  });

  it("renders a phone bottom sheet and dismisses a downward swipe from its content", () => {
    Platform.isPhone = true;
    const fixture = createFixture("background");
    const layer = document.querySelector<HTMLElement>(".inkbook-adaptive-panel-layer");
    const surface = document.querySelector<HTMLElement>(".inkbook-adaptive-panel");
    expect(layer?.dataset.platform).toBe("phone");
    expect(surface?.getAttribute("aria-modal")).toBe("true");
    expect(surface?.dataset.scrollPosition).toBe("top");
    fixture.control.dispatchEvent(pointer("pointerdown", 10, 7, 0));
    surface?.dispatchEvent(pointer("pointermove", 120, 7, 100));
    surface?.dispatchEvent(pointer("pointerup", 120, 7, 120));
    expect(document.querySelector(".inkbook-adaptive-panel")).toBeNull();
    expect(fixture.onClosed).toHaveBeenCalledOnce();
  });

  it("tracks the phone visual viewport and closes from backdrop or public keymap scope", async () => {
    Platform.isPhone = true;
    const viewport = Object.assign(new EventTarget(), {
      height: 500,
      offsetLeft: 0,
      offsetTop: 120,
      width: 360,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });
    const backdropFixture = createFixture("background");
    const layer = document.querySelector<HTMLElement>(".inkbook-adaptive-panel-layer");

    expect(layer?.style.getPropertyValue("--inkbook-adaptive-panel-viewport-left")).toBe("0px");
    expect(layer?.style.getPropertyValue("--inkbook-adaptive-panel-viewport-top")).toBe("120px");
    expect(layer?.style.getPropertyValue("--inkbook-adaptive-panel-viewport-width")).toBe("360px");
    expect(layer?.style.getPropertyValue("--inkbook-adaptive-panel-viewport-height")).toBe("500px");
    viewport.offsetLeft = 24;
    viewport.height = 320;
    viewport.offsetTop = 240;
    viewport.width = 420;
    viewport.dispatchEvent(new Event("resize"));
    await vi.waitFor(() => {
      expect(layer?.style.getPropertyValue("--inkbook-adaptive-panel-viewport-left")).toBe("24px");
      expect(layer?.style.getPropertyValue("--inkbook-adaptive-panel-viewport-top")).toBe("240px");
      expect(layer?.style.getPropertyValue("--inkbook-adaptive-panel-viewport-width")).toBe(
        "420px",
      );
      expect(layer?.style.getPropertyValue("--inkbook-adaptive-panel-viewport-height")).toBe(
        "320px",
      );
    });
    document
      .querySelector<HTMLElement>(".inkbook-adaptive-panel-backdrop")
      ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(document.querySelector(".inkbook-adaptive-panel")).toBeNull();
    expect(backdropFixture.onClosed).toHaveBeenCalledOnce();

    const keymapFixture = createFixture("style");
    const escape = keymapFixture.keymap.scopes[0]?.handlers.find(
      (handler) => handler.key === "Escape",
    );
    expect(escape).toBeDefined();
    expect(escape?.callback(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(false);
    expect(document.querySelector(".inkbook-adaptive-panel")).toBeNull();
    expect(keymapFixture.onClosed).toHaveBeenCalledOnce();
  });
});

describe("AdaptivePanelSession phone swipe behavior", () => {
  it("tracks a content swipe, cancels a reversed drag, and suppresses its trailing click", () => {
    const frames = mockAnimationFrames();
    Platform.isPhone = true;
    const shortSwipe = createFixture("background");
    frames.shift()?.(0);
    const shortSurface = document.querySelector<HTMLElement>(".inkbook-adaptive-panel");
    const activate = vi.fn();
    shortSwipe.control.addEventListener("click", activate);

    shortSwipe.control.dispatchEvent(pointer("pointerdown", 10, 7, 0));
    shortSurface?.dispatchEvent(pointer("pointermove", 60, 7, 100));
    frames.shift()?.(100);
    expect(shortSurface?.style.getPropertyValue("--inkbook-adaptive-panel-drag")).toBe("50px");
    shortSurface?.dispatchEvent(pointer("pointermove", 5, 7, 150));
    frames.shift()?.(150);
    expect(shortSurface?.style.getPropertyValue("--inkbook-adaptive-panel-drag")).toBe("0px");
    shortSurface?.dispatchEvent(pointer("pointerup", 5, 7, 200));
    shortSwipe.control.click();

    expect(document.querySelector(".inkbook-adaptive-panel")).not.toBeNull();
    expect(shortSurface?.style.getPropertyValue("--inkbook-adaptive-panel-drag")).toBe("");
    expect(activate).not.toHaveBeenCalled();
    expect(shortSwipe.onClosed).not.toHaveBeenCalled();
    shortSwipe.session.close("immediate");

    const cancelledSwipe = createFixture("background");
    frames.shift()?.(200);
    const cancelledSurface = document.querySelector<HTMLElement>(".inkbook-adaptive-panel");
    const cancelledGrabber = document.querySelector<HTMLElement>(".inkbook-adaptive-panel-grabber");

    cancelledGrabber?.dispatchEvent(pointer("pointerdown", 10, 8, 0));
    cancelledSurface?.dispatchEvent(pointer("pointermove", 90, 8, 100));
    frames.shift()?.(300);
    cancelledSurface?.dispatchEvent(pointer("pointercancel", 90, 8, 120));

    expect(document.querySelector(".inkbook-adaptive-panel")).not.toBeNull();
    expect(cancelledSurface?.style.getPropertyValue("--inkbook-adaptive-panel-drag")).toBe("");
    expect(cancelledSwipe.onClosed).not.toHaveBeenCalled();
    cancelledSwipe.session.close("immediate");
  });

  it("leaves horizontal control gestures and scrolled content unclaimed", () => {
    Platform.isPhone = true;
    const fixture = createFixture("style");
    const surface = document.querySelector<HTMLElement>(".inkbook-adaptive-panel");
    const scroll = document.querySelector<HTMLElement>(".inkbook-adaptive-panel-scroll");
    const activate = vi.fn();
    fixture.control.addEventListener("click", activate);

    fixture.control.dispatchEvent(pointer("pointerdown", 10, 4, 0, 10));
    surface?.dispatchEvent(pointer("pointermove", 12, 4, 50, 80));
    surface?.dispatchEvent(pointer("pointerup", 12, 4, 80, 80));
    fixture.control.click();

    expect(activate).toHaveBeenCalledOnce();
    expect(surface?.style.getPropertyValue("--inkbook-adaptive-panel-drag")).toBe("");

    if (scroll !== null) scroll.scrollTop = 20;
    scroll?.dispatchEvent(new Event("scroll"));
    expect(surface?.dataset.scrollPosition).toBe("away");
    fixture.control.dispatchEvent(pointer("pointerdown", 10, 5, 100));
    surface?.dispatchEvent(pointer("pointermove", 90, 5, 160));
    surface?.dispatchEvent(pointer("pointerup", 90, 5, 180));

    expect(document.querySelector(".inkbook-adaptive-panel")).not.toBeNull();
    expect(surface?.style.getPropertyValue("--inkbook-adaptive-panel-drag")).toBe("");
    fixture.session.close("immediate");
  });

  it("animates an incomplete swipe back from its released position", () => {
    vi.useFakeTimers();
    Platform.isPhone = true;
    const frames = mockAnimationFrames();
    const fixture = createFixture("style", { motion: "full" });
    frames.shift()?.(0);
    const surface = document.querySelector<HTMLElement>(".inkbook-adaptive-panel");
    const backdrop = document.querySelector<HTMLElement>(".inkbook-adaptive-panel-backdrop");
    fixture.control.dispatchEvent(pointer("pointerdown", 10, 9, 0));
    surface?.dispatchEvent(pointer("pointermove", 50, 9, 100));
    surface?.dispatchEvent(pointer("pointerup", 50, 9, 300));
    expect(surface?.dataset.swipeState).toBe("settling");
    expect(backdrop?.dataset.swipeState).toBe("settling");
    expect(surface?.style.getPropertyValue("--inkbook-adaptive-panel-drag")).toBe("40px");
    frames.shift()?.(16);
    expect(surface?.style.getPropertyValue("--inkbook-adaptive-panel-drag")).toBe("");
    vi.runAllTimers();
    expect(surface?.dataset.swipeState).toBeUndefined();
    expect(backdrop?.dataset.swipeState).toBeUndefined();
    expect(surface?.dataset.presence).toBeUndefined();
    expect(surface?.dataset.state).toBe("open");
    expect(document.querySelector(".inkbook-adaptive-panel")).not.toBeNull();
    fixture.session.close("immediate");
  });
});

describe("AdaptivePanelSession transitions", () => {
  it("makes an animated close immediately inert and restores focus outside the panel", () => {
    vi.useFakeTimers();
    Platform.isPhone = true;
    const fixture = createFixture("background", { motion: "full" });
    const surface = document.querySelector<HTMLElement>(".inkbook-adaptive-panel");
    fixture.control.focus();

    fixture.session.close();

    expect(surface?.dataset.state).toBe("closing");
    expect(surface?.inert).toBe(true);
    expect(surface?.getAttribute("aria-hidden")).toBe("true");
    expect(surface?.contains(document.activeElement)).toBe(false);
    expect(fixture.anchorFocus).toHaveBeenCalledWith({ preventScroll: true });

    vi.runAllTimers();
    expect(document.querySelector(".inkbook-adaptive-panel")).toBeNull();
    expect(fixture.onClosed).toHaveBeenCalledOnce();
  });

  it("hands off without restoring focus", () => {
    const fixture = createFixture("background");

    fixture.session.close("handoff");

    expect(fixture.anchorFocus).not.toHaveBeenCalled();
    expect(fixture.canvasFocus).not.toHaveBeenCalled();
    expect(fixture.onClosed).toHaveBeenCalledOnce();
  });

  it("animates Background content from the height captured before mutation", () => {
    vi.useFakeTimers();
    const frames = mockAnimationFrames();
    let intrinsicHeight = 100;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (!this.classList.contains("inkbook-adaptive-panel-scroll")) return rect(0, 0, 0, 0);
      const explicitHeight = Number.parseFloat(this.style.getPropertyValue("block-size"));
      return rect(0, 0, 199, Number.isFinite(explicitHeight) ? explicitHeight : intrinsicHeight);
    });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("inkbook-adaptive-panel-scroll") ? intrinsicHeight : 0;
    });
    const setProperty = vi.spyOn(CSSStyleDeclaration.prototype, "setProperty");
    let lifecycle: AdaptivePanelContentLifecycle | undefined;
    const fixture = createFixture("background", {
      createContent: (value) => {
        lifecycle = value;
        return window.createFragment();
      },
      motion: "full",
    });
    frames.shift()?.(0);

    lifecycle?.prepareLayoutChange();
    intrinsicHeight = 160;
    lifecycle?.requestLayout();
    frames.shift()?.(16);

    expect(setProperty.mock.calls).toContainEqual(["block-size", "100px"]);
    expect(setProperty.mock.calls).toContainEqual(["block-size", "160px"]);
    fixture.session.close("immediate");
  });
});

describe("phone tool panel entrance layout", () => {
  it.each(["style", "background"] as const)(
    "defers %s height animation until entry completes",
    (kind) => {
      vi.useFakeTimers();
      Platform.isPhone = true;
      const fixture = createFixture(kind, { motion: "full" });
      const surface = document.querySelector<HTMLElement>(".inkbook-adaptive-panel");
      const scroll = surface?.querySelector<HTMLElement>(".inkbook-adaptive-panel-scroll");
      if (scroll == null) throw new Error("Missing scroll surface.");
      vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue(rect(0, 0, 360, 100));
      vi.spyOn(scroll, "scrollHeight", "get").mockReturnValue(180);
      vi.advanceTimersToNextFrame();
      expect(surface?.dataset.state).toBe("open");
      fixture.session.prepareLayoutChange();
      fixture.session.requestLayout();
      vi.advanceTimersToNextFrame();
      expect(surface?.dataset.presence).toBe("entering");
      expect(scroll.style.blockSize).toBe("");
      vi.advanceTimersByTime(220);
      fixture.session.prepareLayoutChange();
      fixture.session.requestLayout();
      vi.advanceTimersToNextFrame();
      expect(surface?.dataset.presence).toBeUndefined();
      expect(scroll.style.blockSize).toBe("180px");
      fixture.session.close("immediate");
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

function pointer(
  type: string,
  clientY: number,
  pointerId: number,
  timeStamp: number,
  clientX = 0,
): PointerEvent {
  const event = new PointerEvent(type, {
    bubbles: true,
    clientX,
    clientY,
    pointerId,
    pointerType: "touch",
  });
  Object.defineProperty(event, "timeStamp", { configurable: true, value: timeStamp });
  return event;
}

function mockWidePanelGeometry(viewportWidth: number): void {
  vi.spyOn(window, "innerWidth", "get").mockReturnValue(viewportWidth);
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains("inkbook-adaptive-panel")) return rect(0, 0, 199, 300);
    return rect(0, 0, 0, 0);
  });
}

function mockAnimationFrames(): FrameRequestCallback[] {
  const frames: FrameRequestCallback[] = [];
  const callbacks = new Map<number, FrameRequestCallback>();
  let handle = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    handle += 1;
    callbacks.set(handle, callback);
    frames.push(callback);
    return handle;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((cancelledHandle) => {
    const callback = callbacks.get(cancelledHandle);
    callbacks.delete(cancelledHandle);
    if (callback === undefined) return;
    const index = frames.indexOf(callback);
    if (index >= 0) frames.splice(index, 1);
  });
  return frames;
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return new DOMRect(left, top, width, height);
}
