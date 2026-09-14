// @vitest-environment happy-dom

import { Platform } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdaptivePanelFixture } from "../../../adapters/obsidian/adaptive-panel";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import {
  createPhoneSheetEditableFixture,
  installKeyboardInsetObserver,
} from "../../../fixtures/obsidian/phone-sheet-editable";

beforeEach(() => {
  installObsidianDomHelpers();
  Platform.isPhone = true;
});
afterEach(() => {
  Platform.isPhone = false;
  Platform.isMobile = false;
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "visualViewport");
  vi.restoreAllMocks();
});

describe("phone sheet keyboard viewport", () => {
  it.each(["full", "reduced"] as const)(
    "applies %s motion to the keyboard-moving layer",
    (motion) => {
      const fixture = createAdaptivePanelFixture("style", { motion });
      const layer = document.querySelector<HTMLElement>(".inkbook-adaptive-panel-layer")!;
      expect(layer.style.getPropertyValue("--inkbook-adaptive-panel-duration")).toBe(
        motion === "full" ? "220ms" : "0ms",
      );
      fixture.session.close("immediate");
    },
  );

  it("repositions and reveals input after a host inset change without viewport events", () => {
    const { fixture, inset, layer } = keyboardOverlayFixture();
    const probe = layer.querySelector(".inkbook-phone-keyboard-inset")!;
    for (const [keyboard, viewportHeight, maximum] of [
      [200, 600, 480],
      [350, 450, 450],
      [0, 800, 480],
    ]) {
      fixture.scroll.scrollTop = 100;
      inset.resize(keyboard!);
      fixture.frames.runNext(1);
      expect(layer.style.getPropertyValue("--inkbook-adaptive-panel-viewport-height")).toBe(
        `${viewportHeight}px`,
      );
      expect(layer.style.getPropertyValue("--inkbook-adaptive-panel-maximum-height")).toBe(
        `${maximum}px`,
      );
      expect(fixture.scroll.scrollTop).toBe(keyboard === 350 ? 210 : 160);
    }
    expect(fixture.inputRead).toHaveBeenCalledTimes(3);
    inset.resize(350);
    fixture.session.close("immediate");
    expect(fixture.frames.pendingCount).toBe(0);
    expect(inset.disconnected).toHaveBeenCalledOnce();
    expect(probe.parentElement).toBeNull();
    inset.resize(0);
    expect(fixture.frames.pendingCount).toBe(0);
  });

  it.each([false, true])(
    "keeps its 60-percent normal cap through keyboard resize (layout resize %s)",
    (adjustResize) => {
      const layoutHeight = vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
      const fixture = createPhoneSheetEditableFixture();
      const layer = fixture.input.closest<HTMLElement>(".inkbook-adaptive-panel-layer")!;
      for (const [height, maximum] of [
        [800, 480],
        [450, 450],
        [400, 400],
        [800, 480],
      ] as const) {
        fixture.viewport.height = height;
        layoutHeight.mockReturnValue(adjustResize ? height : 800);
        fixture.viewport.dispatchEvent(new Event("resize"));
        fixture.frames.runNext(1);
        expect(layer.style.getPropertyValue("--inkbook-adaptive-panel-maximum-height")).toBe(
          `${maximum}px`,
        );
        expect(layer.style.getPropertyValue("--inkbook-adaptive-panel-viewport-height")).toBe(
          `${height}px`,
        );
      }
      fixture.session.close("immediate");
    },
  );
});

describe("phone sheet keyboard movement completion", () => {
  it.each(["height", "block-size"])(
    "reveals the field again after the layer %s transition",
    (propertyName) => {
      const { fixture, inset, layer } = keyboardOverlayFixture();
      inset.resize(350);
      fixture.frames.runNext(1);
      expect(fixture.scroll.scrollTop).toBe(210);
      fixture.scrollRead.mockReturnValue(new DOMRect(0, 20, 360, 430));
      fixture.inputRead.mockReturnValue(new DOMRect(0, -10, 100, 30));
      layer.dispatchEvent(transitionEnd(propertyName));
      expect(fixture.frames.pendingCount).toBe(1);
      fixture.frames.runNext(2);
      expect(fixture.scroll.scrollTop).toBe(180);
      expect(fixture.inputRead).toHaveBeenCalledTimes(2);
      fixture.session.close("immediate");
    },
  );

  it("ignores unrelated transitions and removes the layer listener on close", () => {
    const fixture = createPhoneSheetEditableFixture();
    fixture.viewport.dispatchEvent(new Event("resize"));
    fixture.frames.runNext(1);
    fixture.inputRead.mockClear();
    const layer = fixture.input.closest<HTMLElement>(".inkbook-adaptive-panel-layer")!;
    fixture.scroll.dispatchEvent(transitionEnd("height", true));
    layer.dispatchEvent(transitionEnd("opacity"));
    expect(fixture.frames.pendingCount).toBe(0);
    expect(fixture.inputRead).not.toHaveBeenCalled();
    const remove = vi.spyOn(layer, "removeEventListener");
    fixture.session.close("immediate");
    expect(remove).toHaveBeenCalledWith("transitionend", expect.any(Function));
    layer.dispatchEvent(transitionEnd("height"));
    expect(fixture.frames.pendingCount).toBe(0);
  });
});

describe("phone sheet editable visibility", () => {
  it.each(["textarea", "true", "plaintext-only"])("reveals editable %s", (kind) => {
    const fixture = createPhoneSheetEditableFixture();
    const field = window.createEl(kind === "textarea" ? "textarea" : "div");
    if (kind !== "textarea") field.setAttribute("contenteditable", kind);
    field.tabIndex = 0;
    fixture.input.replaceWith(field);
    vi.spyOn(field, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 530, 100, 30));
    field.focus();
    fixture.viewport.dispatchEvent(new Event("scroll"));
    fixture.frames.runNext(1);
    expect(fixture.scroll.scrollTop).toBe(160);
    fixture.session.close("immediate");
  });

  it("leaves a lower sheet and readonly fields unchanged", () => {
    const fixture = createPhoneSheetEditableFixture();
    const upper = document.body.createDiv({ cls: "inkbook-adaptive-panel-layer" });
    fixture.viewport.dispatchEvent(new Event("resize"));
    fixture.frames.runNext(1);
    expect(fixture.inputRead).not.toHaveBeenCalled();
    upper.remove();
    fixture.input.readOnly = true;
    window.dispatchEvent(new Event("resize"));
    fixture.frames.runNext(2);
    expect(fixture.inputRead).not.toHaveBeenCalled();
    fixture.session.close("immediate");
  });

  it.each([
    [350, 30, 100],
    [530, 30, 160],
    [270, 30, 70],
    [200, 400, 100],
  ])("minimally reveals field at %s with height %s", (top, height, expected) => {
    const fixture = createPhoneSheetEditableFixture();
    fixture.inputRead.mockReturnValue(new DOMRect(0, top, 100, height));
    fixture.viewport.dispatchEvent(new Event("resize"));
    fixture.frames.runNext(1);
    expect(fixture.scroll.scrollTop).toBe(expected);
    expect(document.documentElement.scrollTop).toBe(0);
    fixture.session.close("immediate");
  });

  it("coalesces viewport changes and never undoes manual scrolling or content layout", () => {
    const fixture = createPhoneSheetEditableFixture();
    for (let index = 0; index < 20; index += 1) {
      fixture.viewport.dispatchEvent(new Event("resize"));
      fixture.viewport.dispatchEvent(new Event("scroll"));
    }
    expect(fixture.frames.pendingCount).toBe(1);
    expect(fixture.inputRead).not.toHaveBeenCalled();
    fixture.frames.runNext(1);
    expect(fixture.inputRead).toHaveBeenCalledOnce();
    expect(fixture.scrollRead).toHaveBeenCalledOnce();
    fixture.scroll.scrollTop = 0;
    fixture.scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
    fixture.session.requestLayout();
    fixture.frames.runNext(2);
    expect(fixture.scroll.scrollTop).toBe(0);
    expect(fixture.inputRead).toHaveBeenCalledOnce();
    fixture.session.close("immediate");
    fixture.viewport.dispatchEvent(new Event("resize"));
    expect(fixture.frames.pendingCount).toBe(0);
  });

  it.each([false, true])("leaves desktop/tablet scroll unchanged (mobile %s)", (mobile) => {
    Platform.isPhone = false;
    Platform.isMobile = mobile;
    const fixture = createPhoneSheetEditableFixture();
    fixture.viewport.dispatchEvent(new Event("resize"));
    fixture.frames.runNext(1);
    expect(document.querySelector(".inkbook-phone-keyboard-inset")).toBeNull();
    expect(fixture.scroll.scrollTop).toBe(100);
    expect(fixture.inputRead).not.toHaveBeenCalled();
    expect(
      fixture.input
        .closest<HTMLElement>(".inkbook-adaptive-panel-layer")
        ?.style.getPropertyValue("--inkbook-adaptive-panel-maximum-height"),
    ).toBe("");
    fixture.session.close("immediate");
  });

  it("ignores non-editable controls and cancels pending correction on disposal", () => {
    const fixture = createPhoneSheetEditableFixture();
    fixture.input.type = "checkbox";
    fixture.viewport.dispatchEvent(new Event("resize"));
    fixture.frames.runNext(1);
    expect(fixture.inputRead).not.toHaveBeenCalled();
    fixture.viewport.dispatchEvent(new Event("resize"));
    fixture.session.close("immediate");
    expect(fixture.frames.pendingCount).toBe(0);
  });
});

function transitionEnd(propertyName: string, bubbles = false): Event {
  return Object.assign(new Event("transitionend", { bubbles }), { propertyName });
}

function keyboardOverlayFixture() {
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
  const inset = installKeyboardInsetObserver();
  const fixture = createPhoneSheetEditableFixture();
  fixture.viewport.height = 800;
  fixture.viewport.offsetTop = 0;
  const layer = fixture.input.closest<HTMLElement>(".inkbook-adaptive-panel-layer")!;
  return { fixture, inset, layer };
}
