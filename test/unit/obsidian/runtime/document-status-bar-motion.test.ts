// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { DocumentStatusBarMotion } from "../../../../src/obsidian/runtime/document-status-bar-motion";
import { EASING_TOKENS, type MotionPreference } from "../../../../src/rendering/motion/transitions";
import { createHtmlElement } from "../../../adapters/obsidian/dom";
import { documentStatusBarMotionFixture } from "../../../fixtures/obsidian/document-status-bar-motion";

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function fixture(preference: MotionPreference = "system") {
  const boundary = documentStatusBarMotionFixture();
  cleanups.push(boundary.cleanup);
  const root = createHtmlElement("span");
  const content = createHtmlElement("span");
  root.append(content);
  document.body.append(root);
  boundary.attach(root);
  let current = preference;
  const motion = new DocumentStatusBarMotion(root, content, () => current);
  cleanups.push(() => motion.dispose());
  return {
    ...boundary,
    root,
    content,
    motion,
    preference: (next: MotionPreference): void => {
      current = next;
      motion.refreshMotion();
    },
  };
}

describe("owned status content width motion", () => {
  it("observes content once and adopts its initial width without animating", () => {
    const value = fixture();
    expect(value.construct).toHaveBeenCalledOnce();
    expect(value.observe).toHaveBeenCalledExactlyOnceWith(value.content);
    value.empty();
    value.resize(100, createHtmlElement("span"));
    value.resize(100);
    expect(value.animate).not.toHaveBeenCalled();
    expect(value.root.style.width).toBe("");
  });

  it("animates growing and shrinking natural widths and releases completed effects", () => {
    const value = fixture();
    value.resize(50);
    value.resize(120);
    expect(value.animate).toHaveBeenLastCalledWith([{ width: "50px" }, { width: "120px" }], {
      duration: 120,
      easing: EASING_TOKENS.standard,
    });
    value.animations[0]?.onfinish?.();
    expect(value.animations[0]?.cancel).toHaveBeenCalledOnce();
    value.resize(70);
    expect(value.animate).toHaveBeenLastCalledWith([{ width: "120px" }, { width: "70px" }], {
      duration: 120,
      easing: EASING_TOKENS.standard,
    });
    expect(value.root.style.width).toBe("");
  });

  it("ignores unchanged and invalid widths without consulting the current effect", () => {
    const value = fixture();
    value.resize(50);
    value.resize(100);
    for (const width of [100, -1, Number.NaN, Number.POSITIVE_INFINITY]) value.resize(width);
    expect(value.animate).toHaveBeenCalledOnce();
    expect(value.animations[0]?.effect.getComputedTiming).not.toHaveBeenCalled();
    expect(value.animations[0]?.cancel).not.toHaveBeenCalled();
  });

  it("interrupts from the current interpolation and ignores a superseded finish callback", () => {
    const value = fixture();
    value.resize(50);
    value.resize(150);
    const first = value.animations[0]!;
    const lateFinish = first.onfinish;
    value.resize(80);
    expect(first.effect.getComputedTiming).toHaveBeenCalledOnce();
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(first.onfinish).toBeNull();
    expect(value.animate).toHaveBeenLastCalledWith(
      [{ width: "100px" }, { width: "80px" }],
      expect.anything(),
    );
    lateFinish?.();
    expect(value.animations[1]?.cancel).not.toHaveBeenCalled();
    value.animations[1]!.effect.getComputedTiming.mockReturnValue({ progress: null });
    value.resize(90);
    expect(value.animate).toHaveBeenLastCalledWith(
      [{ width: "80px" }, { width: "90px" }],
      expect.anything(),
    );
  });
});

describe("status width motion preferences and lifecycle", () => {
  it.each(["reduced", "system", "full"] as const)(
    "honors %s and live system motion changes",
    (preference) => {
      const value = fixture(preference);
      value.query.matches = true;
      value.resize(50);
      value.resize(100);
      expect(value.animate).toHaveBeenCalledTimes(preference === "full" ? 1 : 0);
      value.preference("full");
      value.resize(120);
      const active = value.animations[value.animations.length - 1]!;
      value.preference("system");
      expect(active.cancel).toHaveBeenCalledOnce();
      value.query.matches = false;
      value.mediaChanged();
      value.resize(140);
      const resumed = value.animations[value.animations.length - 1]!;
      value.query.matches = true;
      value.mediaChanged();
      expect(resumed.cancel).toHaveBeenCalledOnce();
    },
  );

  it("cancels at zero width and avoids animating detached presentations", () => {
    const value = fixture();
    value.resize(50);
    value.resize(100);
    value.resize(0);
    expect(value.animations[0]?.cancel).toHaveBeenCalledOnce();
    value.resize(80);
    expect(value.animate).toHaveBeenCalledOnce();
    value.root.remove();
    value.resize(120);
    expect(value.animate).toHaveBeenCalledOnce();
    document.body.append(value.root);
    value.resize(140);
    expect(value.animate).toHaveBeenLastCalledWith(
      [{ width: "120px" }, { width: "140px" }],
      expect.anything(),
    );
  });

  it("releases observation, media subscriptions and animations exactly once", () => {
    const value = fixture();
    value.resize(50);
    value.resize(100);
    const lateFinish = value.animations[0]?.onfinish;
    value.motion.dispose();
    value.motion.dispose();
    value.resize(200);
    value.mediaChanged();
    lateFinish?.();
    expect(value.disconnect).toHaveBeenCalledOnce();
    expect(value.query.removeEventListener).toHaveBeenCalledExactlyOnceWith(
      "change",
      value.query.addEventListener.mock.calls[0]?.[1],
    );
    expect(value.animations[0]?.cancel).toHaveBeenCalledOnce();
    expect(value.animate).toHaveBeenCalledOnce();
  });
});

describe("status width motion unavailable browser APIs", () => {
  it("adopts sizes when Web Animations is unavailable", () => {
    const value = fixture();
    Object.defineProperty(value.root, "animate", { configurable: true, value: undefined });
    value.resize(50);
    value.resize(100);
    expect(value.animate).not.toHaveBeenCalled();
  });

  it("remains inert without an owning window or ResizeObserver", () => {
    const value = fixture();
    Object.defineProperty(window, "ResizeObserver", { configurable: true, value: undefined });
    const missingObserver = new DocumentStatusBarMotion(value.root, value.content, () => "full");
    const detachedDocument = document.implementation.createHTMLDocument();
    Object.defineProperty(detachedDocument, "defaultView", { configurable: true, value: null });
    const detached = detachedDocument.adoptNode(createHtmlElement("span"));
    const missingWindow = new DocumentStatusBarMotion(detached, detached, () => "system");
    missingObserver.refreshMotion();
    missingWindow.refreshMotion();
    missingObserver.dispose();
    missingWindow.dispose();
    expect(value.construct).toHaveBeenCalledOnce();
    expect(value.animate).not.toHaveBeenCalled();
  });
});
