// @vitest-environment happy-dom

import { Platform } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdaptivePanelSession } from "../../../../src/obsidian/menus/adaptive-panel";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

beforeEach(() => {
  installObsidianDomHelpers();
  Platform.isPhone = true;
  vi.useFakeTimers();
});
afterEach(() => {
  Platform.isPhone = false;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup(anchor: HTMLElement = document.body) {
  const layer = window.createDiv();
  const surface = layer.appendChild(window.createEl("section"));
  const initialFocus = window.createEl("input");
  const onClosing = vi.fn();
  const onClosed = vi.fn();
  const session = new AdaptivePanelSession({
    anchor,
    canvasInputSurface: document.body,
    durationMs: 220,
    layer,
    surface,
    initialFocus,
    onClosing,
    onClosed,
    kind: "dialog",
    label: "Settings",
    ownerDocument: document,
    ownerWindow: window,
    renderIcon: vi.fn(),
    createContent: () => {
      const fragment = window.createFragment();
      fragment.append(initialFocus);
      return fragment;
    },
  });
  return { session, layer, surface, initialFocus, onClosing, onClosed };
}

describe("adaptive dialog reuse", () => {
  it("starts phone focus without a ring even when its trigger inherited keyboard navigation", () => {
    const anchor = document.body.createEl("button");
    anchor.dataset.inkbookKeyboardNavigation = "true";
    const fixture = setup(anchor);
    vi.advanceTimersToNextFrame();
    expect(document.activeElement).toBe(fixture.initialFocus);
    expect(fixture.layer.dataset.inkbookKeyboardNavigation).toBe("false");
    fixture.initialFocus.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(fixture.layer.dataset.inkbookKeyboardNavigation).toBe("true");
    window.dispatchEvent(new Event("pointerdown"));
    expect(fixture.layer.dataset.inkbookKeyboardNavigation).toBe("false");
    fixture.session.close("immediate");
  });

  it("lets animated disclosures resize the sheet without a second fixed-height transition", () => {
    const fixture = setup();
    vi.advanceTimersByTime(250);
    const scroll = fixture.surface.querySelector<HTMLElement>(".inkbook-adaptive-panel-scroll")!;
    vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 360, 400));
    const contentHeight = vi.spyOn(scroll, "scrollHeight", "get");
    for (const height of [700, 560, 420, 300, 180]) {
      contentHeight.mockReturnValue(height);
      fixture.session.requestLayout();
      vi.advanceTimersToNextFrame();
      expect(scroll.style.blockSize).toBe("");
    }
    fixture.session.close("immediate");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves supplied node identity and focuses the explicit control after mounting", () => {
    const fixture = setup();
    expect(document.querySelector(".inkbook-adaptive-panel-layer")).toBe(fixture.layer);
    expect(document.querySelector(".inkbook-adaptive-panel")).toBe(fixture.surface);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    vi.advanceTimersToNextFrame();
    expect(document.activeElement).toBe(fixture.initialFocus);
    fixture.session.close("immediate");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips controls inside hidden and inert disclosure ancestors when tabbing", () => {
    const fixture = setup();
    const hidden = fixture.surface.createDiv();
    hidden.hidden = true;
    hidden.createEl("button");
    const inert = fixture.surface.createDiv();
    inert.inert = true;
    inert.createEl("button");
    const visible = fixture.surface.createEl("button");
    vi.advanceTimersToNextFrame();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(visible);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(fixture.initialFocus);
    fixture.session.close("immediate");
  });

  it("lets owner disposal finish an exiting sheet without waiting or notifying twice", () => {
    const fixture = setup();
    fixture.session.close();
    expect(fixture.surface.isConnected).toBe(true);
    expect(fixture.onClosing).toHaveBeenCalledOnce();
    fixture.session.close("immediate");
    fixture.session.close("immediate");
    expect(fixture.surface.isConnected).toBe(false);
    expect(fixture.onClosed).toHaveBeenCalledOnce();
    expect(fixture.onClosing).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not animate content block size while the phone sheet enters", () => {
    const fixture = setup();
    vi.advanceTimersToNextFrame();
    const scroll = fixture.surface.querySelector<HTMLElement>(".inkbook-adaptive-panel-scroll");
    if (scroll === null) throw new Error("Missing sheet scroll owner.");
    vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 360, 100));
    vi.spyOn(scroll, "scrollHeight", "get").mockReturnValue(180);
    fixture.session.prepareLayoutChange();
    fixture.session.requestLayout();
    vi.advanceTimersToNextFrame();
    expect(fixture.surface.dataset.presence).toBe("entering");
    expect(scroll.style.blockSize).toBe("");
    fixture.session.close("immediate");
  });
});

describe("nested phone dialog ownership", () => {
  it.each(["Escape", "backdrop"])(
    "dismisses only the top sheet on %s and returns parent focus",
    (dismissal) => {
      const parent = setup();
      vi.advanceTimersToNextFrame();
      const child = setup(parent.initialFocus);
      vi.advanceTimersToNextFrame();
      expect(document.activeElement).toBe(child.initialFocus);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      expect(document.activeElement).toBe(child.initialFocus);
      if (dismissal === "Escape") {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      } else {
        child.layer
          .querySelector(".inkbook-adaptive-panel-backdrop")
          ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      }
      expect(child.surface.dataset.state).toBe("closing");
      expect(parent.surface.dataset.state).toBe("open");
      expect(parent.onClosing).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(parent.initialFocus);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(parent.onClosing).not.toHaveBeenCalled();
      vi.advanceTimersByTime(220);
      expect(child.surface.isConnected).toBe(false);
      expect(child.onClosed).toHaveBeenCalledOnce();
      expect(parent.surface.isConnected).toBe(true);
      expect(document.activeElement).toBe(parent.initialFocus);
      parent.session.close("immediate");
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe("phone dialog programmatic focus containment", () => {
  it("retains the last inside control when a retiring native menu restores its trigger", () => {
    const outside = document.body.createEl("button");
    const fixture = setup(outside);
    vi.advanceTimersToNextFrame();
    const inside = fixture.surface.createEl("button");
    inside.focus();
    outside.focus();
    expect(document.activeElement).toBe(inside);
    fixture.session.close("immediate");
    outside.focus();
    expect(document.activeElement).toBe(outside);
  });

  it("lets only the topmost sheet contain focus and restores the parent after closing", () => {
    const outside = document.body.createEl("button");
    const parent = setup(outside);
    vi.advanceTimersToNextFrame();
    const child = setup(parent.initialFocus);
    vi.advanceTimersToNextFrame();
    const childControl = child.surface.createEl("button");
    childControl.focus();
    outside.focus();
    expect(document.activeElement).toBe(childControl);
    parent.initialFocus.focus();
    expect(document.activeElement).toBe(childControl);
    child.session.close("immediate");
    expect(document.activeElement).toBe(parent.initialFocus);
    outside.focus();
    expect(document.activeElement).toBe(parent.initialFocus);
    parent.session.close("immediate");
    expect(document.activeElement).toBe(outside);
  });

  it.each(["hidden", "inert"] as const)(
    "falls back to the sheet when the last focused ancestor becomes %s",
    (state) => {
      const outside = document.body.createEl("button");
      const fixture = setup(outside);
      vi.advanceTimersToNextFrame();
      const group = fixture.surface.createDiv();
      const control = group.createEl("button");
      control.focus();
      group[state] = true;
      outside.focus();
      expect(document.activeElement).toBe(fixture.surface);
      fixture.session.close("immediate");
    },
  );
});
