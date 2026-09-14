// @vitest-environment happy-dom

import { Modal, Platform, type App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InkbookMotionModal } from "../../../../src/obsidian/dialogs/inkbook-motion-modal";
import { installDialogTestLifecycle } from "../../../fixtures/obsidian/dialog";

installDialogTestLifecycle();

function setup() {
  const animations: Array<Animation & { cancel: ReturnType<typeof vi.fn> }> = [];
  const modal = new InkbookMotionModal({ workspace: { containerEl: document.body } } as App);
  const animate = vi.fn(() => {
    const animation = {
      finished: Promise.resolve(),
      cancel: vi.fn(),
      onfinish: null,
      oncancel: null,
    } as unknown as Animation & { cancel: ReturnType<typeof vi.fn> };
    animations.push(animation);
    return animation;
  });
  Object.defineProperty(modal.modalEl, "animate", { configurable: true, value: animate });
  return { modal, animate, animations };
}

function finish(animation: Animation | undefined): void {
  animation?.onfinish?.call(animation, {} as AnimationPlaybackEvent);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  Object.assign(Platform, { isMobile: false, isPhone: false });
  vi.useRealTimers();
});

describe("native modal motion", () => {
  it.each([false, true])(
    "animates desktop/tablet and retains the native shell until exit: %s",
    (tablet) => {
      Object.assign(Platform, { isMobile: tablet });
      const { modal, animate, animations } = setup();
      const hostClose = vi.spyOn(Modal.prototype, "close");
      modal.open();
      expect(animate).toHaveBeenLastCalledWith(
        [
          { scale: "0.96", opacity: "0" },
          { scale: "1", opacity: "1" },
        ],
        {
          duration: 120,
          easing: "ease-out",
          fill: "both",
        },
      );
      finish(animations[0]);
      modal.close();
      expect(modal.modalEl.isConnected).toBe(true);
      expect(modal.modalEl.inert).toBe(true);
      expect(hostClose).not.toHaveBeenCalled();
      expect(animate).toHaveBeenLastCalledWith(
        [
          { scale: "1", opacity: "1" },
          { scale: "0.96", opacity: "0" },
        ],
        {
          duration: 120,
          easing: "ease-out",
          fill: "both",
        },
      );
      finish(animations[1]);
      expect(hostClose).toHaveBeenCalledOnce();
      expect(modal.modalEl.isConnected).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("samples the current entrance scale when interrupted and ignores repeated close", () => {
    const { modal, animate, animations } = setup();
    modal.open();
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      scale: "0.97",
      opacity: "0.42",
    } as CSSStyleDeclaration);
    modal.close();
    modal.close();
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animate).toHaveBeenLastCalledWith(
      [
        { scale: "0.97", opacity: "0.42" },
        { scale: "0.96", opacity: "0" },
      ],
      expect.any(Object),
    );
    expect(animations[0]?.cancel.mock.calls).toHaveLength(1);
    vi.advanceTimersByTime(119);
    expect(modal.modalEl.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(modal.modalEl.isConnected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases entrance animation resources on its fallback deadline", () => {
    const { modal, animations } = setup();
    modal.open();
    modal.open();
    vi.advanceTimersByTime(120);
    expect(animations).toHaveLength(1);
    expect(animations[0]?.cancel.mock.calls).toHaveLength(1);
    expect(modal.modalEl.isConnected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["entering", "closing"])(
    "disposes owned animation and timers on pagehide while %s",
    (phase) => {
      const { modal, animations } = setup();
      const hostClose = vi.spyOn(Modal.prototype, "close");
      modal.open();
      if (phase === "closing") modal.close();
      window.dispatchEvent(new Event("pagehide"));
      expect(modal.modalEl.isConnected).toBe(false);
      expect(animations[animations.length - 1]?.cancel.mock.calls).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      modal.closeImmediately();
      modal.close();
      expect(hostClose).toHaveBeenCalledOnce();
    },
  );
});

describe("native modal motion fallbacks", () => {
  it.each(["reduced", "system"] as const)("honors reduced-motion preference %s", (preference) => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    const modal = new InkbookMotionModal(
      { workspace: { containerEl: document.body } } as App,
      () => preference,
    );
    const animate = vi.fn();
    Object.defineProperty(modal.modalEl, "animate", { value: animate });
    modal.open();
    modal.close();
    expect(animate).not.toHaveBeenCalled();
    expect(modal.modalEl.isConnected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes immediately when the owner does not support Web Animations", () => {
    const modal = new InkbookMotionModal({ workspace: { containerEl: document.body } } as App);
    Object.defineProperty(modal.modalEl, "animate", { value: undefined });
    modal.close();
    modal.open();
    modal.close();
    expect(modal.modalEl.isConnected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
