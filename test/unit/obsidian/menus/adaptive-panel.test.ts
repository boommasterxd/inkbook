// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keymap, Platform } from "obsidian";

import {
  AdaptivePanelSession,
  type AdaptivePanelContentLifecycle,
} from "../../../../src/obsidian/menus/adaptive-panel";
import { createHtmlElement, installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

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

  it("anchors below the trigger, clamps inline, and flips above near the viewport edge", () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(500);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains("inkbook-adaptive-panel")) return rect(0, 0, 199, 300);
      return rect(0, 0, 0, 0);
    });

    const fixture = createFixture("background", { anchorRect: rect(470, 700, 44, 44) });
    const surface = document.querySelector<HTMLElement>(".inkbook-adaptive-panel");

    expect(surface?.style.insetInlineStart).toBe("293px");
    expect(surface?.style.insetBlockStart).toBe("398px");
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
  it("renders a phone bottom sheet and dismisses a downward grabber swipe", () => {
    Platform.isPhone = true;
    const fixture = createFixture("background");
    const layer = document.querySelector<HTMLElement>(".inkbook-adaptive-panel-layer");
    const surface = document.querySelector<HTMLElement>(".inkbook-adaptive-panel");
    const grabber = document.querySelector<HTMLElement>(".inkbook-adaptive-panel-grabber");

    expect(layer?.dataset.platform).toBe("phone");
    expect(surface?.getAttribute("aria-modal")).toBe("true");
    grabber?.dispatchEvent(pointer("pointerdown", 10, 7, 0));
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

  it("keeps short and cancelled grabber swipes open and clears drag state", () => {
    Platform.isPhone = true;
    const shortSwipe = createFixture("background");
    const shortSurface = document.querySelector<HTMLElement>(".inkbook-adaptive-panel");
    const shortGrabber = document.querySelector<HTMLElement>(".inkbook-adaptive-panel-grabber");

    shortGrabber?.dispatchEvent(pointer("pointerdown", 10, 7, 0));
    shortSurface?.dispatchEvent(pointer("pointermove", 60, 7, 100));
    expect(shortSurface?.style.getPropertyValue("--inkbook-adaptive-panel-drag")).toBe("50px");
    shortSurface?.dispatchEvent(pointer("pointerup", 60, 7, 200));

    expect(document.querySelector(".inkbook-adaptive-panel")).not.toBeNull();
    expect(shortSurface?.style.getPropertyValue("--inkbook-adaptive-panel-drag")).toBe("");
    expect(shortSwipe.onClosed).not.toHaveBeenCalled();
    shortSwipe.session.close("immediate");

    const cancelledSwipe = createFixture("background");
    const cancelledSurface = document.querySelector<HTMLElement>(".inkbook-adaptive-panel");
    const cancelledGrabber = document.querySelector<HTMLElement>(".inkbook-adaptive-panel-grabber");

    cancelledGrabber?.dispatchEvent(pointer("pointerdown", 10, 8, 0));
    cancelledSurface?.dispatchEvent(pointer("pointermove", 90, 8, 100));
    cancelledSurface?.dispatchEvent(pointer("pointercancel", 90, 8, 120));

    expect(document.querySelector(".inkbook-adaptive-panel")).not.toBeNull();
    expect(cancelledSurface?.style.getPropertyValue("--inkbook-adaptive-panel-drag")).toBe("");
    expect(cancelledSwipe.onClosed).not.toHaveBeenCalled();
    cancelledSwipe.session.close("immediate");
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
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
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

function createFixture(
  kind: "background" | "style",
  options: {
    readonly anchorRect?: DOMRect;
    readonly createContent?: (lifecycle: AdaptivePanelContentLifecycle) => DocumentFragment;
    readonly motion?: "full" | "reduced";
  } = {},
) {
  const root = createHtmlElement("div");
  root.className = "inkbook-root";
  root.dataset.inkbookMotion = options.motion ?? "reduced";
  const anchor = createHtmlElement("button");
  const canvas = createHtmlElement("div");
  const control = createHtmlElement("button");
  control.textContent = "First";
  root.append(anchor, canvas);
  document.body.append(root);
  const anchorFocus = vi.spyOn(anchor, "focus");
  const canvasFocus = vi.spyOn(canvas, "focus");
  anchor.getBoundingClientRect = () => options.anchorRect ?? rect(300, 100, 44, 44);
  const keymap = new Keymap() as Keymap & {
    readonly scopes: Array<{
      readonly handlers: Array<{
        readonly callback: (event: KeyboardEvent) => unknown;
        readonly key: string | null;
      }>;
    }>;
  };
  const onClosed = vi.fn();
  const session = new AdaptivePanelSession({
    anchor,
    canvasInputSurface: canvas,
    createContent:
      options.createContent ??
      (() => {
        const fragment = window.createFragment();
        fragment.append(control);
        return fragment;
      }),
    keymap,
    kind,
    label: kind === "style" ? "Style" : "Background",
    onClosed,
    ownerDocument: document,
    ownerWindow: window,
    renderIcon: (element, icon) => element.setAttribute("data-icon", icon),
  });
  return { anchor, anchorFocus, canvas, canvasFocus, control, keymap, onClosed, session };
}

function pointer(
  type: string,
  clientY: number,
  pointerId: number,
  timeStamp: number,
): PointerEvent {
  const event = new PointerEvent(type, {
    bubbles: true,
    clientY,
    pointerId,
    pointerType: "touch",
  });
  Object.defineProperty(event, "timeStamp", { configurable: true, value: timeStamp });
  return event;
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return new DOMRect(left, top, width, height);
}
