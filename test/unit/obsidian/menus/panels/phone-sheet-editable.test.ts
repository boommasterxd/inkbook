// @vitest-environment happy-dom

import { Platform } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";
import { touchPointer } from "../../../../fixtures/obsidian/phone-sheet-swipe";
import {
  createPhoneSheetEditableFixture,
  installKeyboardInsetObserver,
} from "../../../../fixtures/obsidian/phone-sheet-editable";

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

describe("phone sheet editable fixture restoration", () => {
  it.for([false, true])("restores plain callbacks and viewport after failure=%s", (fail) => {
    const request = Object.getOwnPropertyDescriptor(window, "requestAnimationFrame");
    const cancel = Object.getOwnPropertyDescriptor(window, "cancelAnimationFrame");
    const priorViewport = { height: 700 };
    Object.defineProperty(window, "visualViewport", { configurable: true, value: priorViewport });
    const viewport = Object.getOwnPropertyDescriptor(window, "visualViewport");
    const inset = installKeyboardInsetObserver();
    const fixture = createPhoneSheetEditableFixture(false);
    let caught: unknown;
    try {
      fixture.viewport.dispatchEvent(new Event("resize"));
      inset.resize(350);
      fixture.frames.runNext(0);
      expect(fixture.inputReadCount).toBe(1);
      expect(fixture.scrollReadCount).toBe(1);
      expect(fixture.inputRead).not.toHaveBeenCalled();
      expect(fixture.scrollRead).not.toHaveBeenCalled();
      if (fail) throw new Error("Injected failure");
    } catch (error) {
      caught = error;
    } finally {
      try {
        fixture.session.close("immediate");
      } finally {
        fixture.restore();
      }
    }
    if (fail) expect(caught).toEqual(new Error("Injected failure"));
    else expect(caught).toBeUndefined();
    expect(fixture.frames.pendingCount).toBe(0);
    expect(Object.getOwnPropertyDescriptor(window, "requestAnimationFrame")).toEqual(request);
    expect(Object.getOwnPropertyDescriptor(window, "cancelAnimationFrame")).toEqual(cancel);
    expect(Object.getOwnPropertyDescriptor(window, "visualViewport")).toEqual(viewport);
    fixture.restore();
    expect(window.visualViewport).toBe(priorViewport);
  });
});

describe("phone sheet keyboard motion", () => {
  it("reveals the focused field again after keyboard motion, independently of swipe", async () => {
    const fixture = createPhoneSheetEditableFixture(true, "full");
    try {
      const layer = fixture.input.closest<HTMLElement>(".inkbook-adaptive-panel-layer")!;
      const surface = fixture.input.closest<HTMLElement>(".inkbook-adaptive-panel")!;
      await fixture.advanceMotion(300);
      surface
        .querySelector(".inkbook-adaptive-panel-drag-region")!
        .dispatchEvent(touchPointer("pointerdown", 10, 1, 0));
      surface.dispatchEvent(touchPointer("pointermove", 40, 1, 100));
      fixture.frames.runNext(1);
      fixture.viewport.height = 300;
      fixture.viewport.dispatchEvent(new Event("resize"));
      fixture.frames.runNext(1);
      expect(fixture.inputRead).toHaveBeenCalledOnce();
      await fixture.advanceMotion(100);
      expect(Number.parseFloat(layer.style.blockSize)).toBeGreaterThan(300);
      expect(Number.parseFloat(layer.style.blockSize)).toBeLessThan(400);
      expect(fixture.inputRead).toHaveBeenCalledOnce();
      fixture.scroll.scrollTop = 100;
      await fixture.advanceMotion(200);
      fixture.frames.runNext(2);
      expect(fixture.inputRead).toHaveBeenCalledTimes(2);
      expect(fixture.scroll.scrollTop).toBe(260);
      expect(document.activeElement).toBe(fixture.input);
      expect(surface.style.translate).toBe("0 30px");
      expect(fixture.frames.pendingCount).toBe(0);
    } finally {
      fixture.session.close("immediate");
      fixture.restore();
    }
  });

  it("retargets keyboard motion and finishes Reduced immediately without a stale correction", async () => {
    const fixture = createPhoneSheetEditableFixture(true, "full");
    try {
      const layer = fixture.input.closest<HTMLElement>(".inkbook-adaptive-panel-layer")!;
      const root = fixture.anchor.closest<HTMLElement>(".inkbook-root")!;
      fixture.viewport.height = 250;
      fixture.viewport.dispatchEvent(new Event("resize"));
      fixture.frames.runNext(1);
      await fixture.advanceMotion(100);
      fixture.viewport.height = 500;
      fixture.viewport.dispatchEvent(new Event("resize"));
      fixture.frames.runNext(2);
      await fixture.advanceMotion(100);
      expect(fixture.inputRead).toHaveBeenCalledTimes(2);
      root.dataset.inkbookMotion = "reduced";
      await Promise.resolve();
      expect(layer.style.blockSize).toBe("500px");
      fixture.frames.runNext(3);
      expect(fixture.inputRead).toHaveBeenCalledTimes(3);
      await fixture.advanceMotion(300);
      expect(fixture.frames.pendingCount).toBe(0);
      fixture.viewport.height = 350;
      fixture.viewport.dispatchEvent(new Event("resize"));
      fixture.frames.runNext(4);
      expect(layer.style.blockSize).toBe("350px");
      expect(fixture.inputRead).toHaveBeenCalledTimes(4);
      expect(fixture.frames.pendingCount).toBe(0);
    } finally {
      fixture.session.close("immediate");
      fixture.restore();
    }
  });

  it("discards a pending keyboard-motion correction when the sheet closes", async () => {
    const fixture = createPhoneSheetEditableFixture(true, "full");
    try {
      fixture.viewport.height = 300;
      fixture.viewport.dispatchEvent(new Event("resize"));
      fixture.frames.runNext(1);
      fixture.session.close("immediate");
      await fixture.advanceMotion(300);
      expect(fixture.inputRead).toHaveBeenCalledOnce();
      expect(fixture.frames.pendingCount).toBe(0);
    } finally {
      fixture.session.close("immediate");
      fixture.restore();
    }
  });
});

describe("phone sheet keyboard viewport", () => {
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
    fixture.session.mutateLayout(() => undefined);
    expect(fixture.frames.pendingCount).toBe(0);
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

function keyboardOverlayFixture() {
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
  const inset = installKeyboardInsetObserver();
  const fixture = createPhoneSheetEditableFixture();
  fixture.viewport.height = 800;
  fixture.viewport.offsetTop = 0;
  const layer = fixture.input.closest<HTMLElement>(".inkbook-adaptive-panel-layer")!;
  return { fixture, inset, layer };
}
