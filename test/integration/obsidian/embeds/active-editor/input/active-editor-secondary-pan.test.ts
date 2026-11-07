// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installObsidianDomHelpers } from "../../../../../adapters/obsidian/dom";
import { createHarness } from "../../../../../fixtures/obsidian/active-controller";

beforeEach(() => {
  installObsidianDomHelpers();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("secondary click context menu", () => {
  it("opens a jittered click menu once at the original position despite native event ordering", () => {
    const h = createHarness();
    try {
      h.controller.handlePointerDown(secondary());
      const early = nativeMenu();
      h.controller.handleContextMenu(early);
      expect(early.defaultPrevented).toBe(true);
      expect(h.menu.positions).toHaveLength(0);
      h.controller.handlePointerMove(secondary({ clientX: 54, clientY: 102 }));
      h.controller.handlePointerUp(secondary({ buttons: 0, clientX: 54, clientY: 102 }));
      expect(h.menu.positions).toHaveLength(1);
      expect(h.menu.positions[0]?.position).toMatchObject({ x: 50, y: 100 });
      expect(h.renderer.setSelectedElements.mock.lastCall?.[0].size).toBe(1);
      const late = nativeMenu();
      h.controller.handleContextMenu(late);
      expect(late.defaultPrevented).toBe(true);
      expect(h.menu.positions).toHaveLength(1);
      expect(h.capture.release).toHaveBeenCalledWith(7);
      expect(h.renderer.setPreviewTransform).not.toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  });
});

describe("secondary drag navigation", () => {
  it.each([false, true])("routes vertical drags to native scroll with selected=%s", (selected) => {
    const h = createHarness();
    try {
      if (selected) h.selectElement();
      h.renderer.setSelectedElements.mockClear();
      document.body.scrollTop = 200;
      const before = h.controller.getViewState();
      h.controller.handlePointerDown(secondary());
      h.controller.handlePointerMove(secondary({ clientX: 52, clientY: 120 }));
      vi.advanceTimersByTime(30);
      expect(document.body.scrollTop).toBe(180);
      h.controller.handlePointerMove(secondary({ clientX: 130, clientY: 130 }));
      vi.advanceTimersByTime(30);
      expect(document.body.scrollTop).toBe(170);
      h.controller.handlePointerUp(secondary({ buttons: 0, clientX: 130, clientY: 130 }));
      h.controller.handleContextMenu(nativeMenu());
      const completedScroll = document.body.scrollTop;
      vi.advanceTimersByTime(1_000);
      expect(document.body.scrollTop).toBe(completedScroll);
      expect(h.controller.getViewState()).toEqual(before);
      expect(h.menu.positions).toHaveLength(0);
      expect(h.renderer.setSelectedElements).not.toHaveBeenCalled();
      expect(h.renderer.setPreviewTransform).not.toHaveBeenCalled();
      expect(h.renderer.setLivePath).not.toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  });

  it("uses horizontal camera pan and ignores subsequent vertical movement", () => {
    const h = createHarness();
    try {
      h.controller.restoreViewState({ cameraX: -200, zoom: 1 });
      document.body.scrollTop = 200;
      h.controller.handlePointerDown(secondary({ clientX: 400, clientY: 300 }));
      h.controller.handlePointerMove(secondary({ clientX: 420, clientY: 302 }));
      vi.advanceTimersByTime(30);
      expect(h.controller.getViewState().cameraX).toBe(-180);
      h.controller.handlePointerMove(secondary({ clientX: 430, clientY: 380 }));
      vi.advanceTimersByTime(30);
      expect(h.controller.getViewState().cameraX).toBe(-170);
      expect(document.body.scrollTop).toBe(200);
      h.controller.handlePointerUp(secondary({ buttons: 0, clientX: 430, clientY: 380 }));
      vi.advanceTimersByTime(1_000);
      expect(h.controller.getViewState().cameraX).toBe(-170);
      expect(h.menu.positions).toHaveLength(0);
    } finally {
      h.dispose();
    }
  });
});

describe("secondary drag recovery", () => {
  it("retains the first threshold-crossing axis after a coalesced excursion returns", () => {
    const h = createHarness();
    try {
      h.controller.restoreViewState({ cameraX: -200, zoom: 1 });
      h.controller.handlePointerDown(secondary({ clientX: 400, clientY: 300 }));
      const move = secondary({ clientX: 400, clientY: 300 });
      Object.defineProperty(move, "getCoalescedEvents", {
        value: () => [
          secondary({ clientX: 406, clientY: 300 }),
          secondary({ clientX: 420, clientY: 300 }),
          secondary({ clientX: 400, clientY: 350 }),
          move,
        ],
      });
      h.controller.handlePointerMove(move);
      h.controller.handlePointerMove(secondary({ clientX: 420, clientY: 300 }));
      vi.advanceTimersByTime(30);
      expect(h.controller.getViewState().cameraX).toBe(-180);
      h.controller.handlePointerUp(secondary({ buttons: 0, clientX: 420, clientY: 300 }));
      h.controller.handleContextMenu(nativeMenu());
      expect(h.menu.positions).toHaveLength(0);
      expect(h.capture.release).toHaveBeenCalledWith(7);
      h.key("F10", { shiftKey: true });
      expect(h.menu.positions).toHaveLength(1);
      h.menu.close();
      const keyboardMenu = new MouseEvent("contextmenu", { button: 0, cancelable: true });
      const open = vi.spyOn(h.menu, "onHide");
      h.controller.handleContextMenu(keyboardMenu);
      expect(open).toHaveBeenCalledOnce();
    } finally {
      h.dispose();
    }
  });

  it.each(["cancel", "lost-capture", "blur"])(
    "recovers %s and suppresses its trailing contextmenu",
    (terminal) => {
      const h = createHarness();
      try {
        h.controller.handlePointerDown(secondary());
        h.controller.handlePointerMove(secondary({ clientY: 180 }));
        vi.advanceTimersByTime(30);
        if (terminal === "cancel") h.controller.handlePointerCancel(secondary());
        else if (terminal === "lost-capture") h.controller.handleLostPointerCapture(secondary());
        else window.dispatchEvent(new Event("blur"));
        const menu = nativeMenu();
        h.controller.handleContextMenu(menu);
        expect(menu.defaultPrevented).toBe(true);
        expect(h.menu.positions).toHaveLength(0);
        expect(h.capture.release).toHaveBeenCalledWith(7);
        h.controller.handlePointerDown(
          secondary({ button: 0, buttons: 1, pointerId: 8, clientX: 400 }),
        );
        expect(h.capture.set).toHaveBeenLastCalledWith(8);
        h.controller.handlePointerCancel(secondary({ pointerId: 8 }));
      } finally {
        h.dispose();
      }
    },
  );

  it("cancels a hidden document's pending click before the same mouse pointer is reused", () => {
    const h = createHarness();
    const hidden = vi.spyOn(document, "hidden", "get");
    try {
      h.controller.handlePointerDown(secondary());
      hidden.mockReturnValue(false);
      document.dispatchEvent(new Event("visibilitychange"));
      expect(h.capture.release).not.toHaveBeenCalled();
      hidden.mockReturnValue(true);
      document.dispatchEvent(new Event("visibilitychange"));
      hidden.mockReturnValue(false);
      document.dispatchEvent(new Event("visibilitychange"));
      expect(h.capture.release).toHaveBeenCalledWith(7);
      h.controller.handlePointerDown(secondary({ button: 0, buttons: 1, clientX: 400 }));
      h.controller.handlePointerUp(secondary({ button: 0, buttons: 0, clientX: 400 }));
      expect(h.menu.positions).toHaveLength(0);
      expect(h.capture.set.mock.calls.filter(([id]) => id === 7)).toHaveLength(2);
    } finally {
      hidden.mockRestore();
      h.dispose();
    }
  });
});

function secondary(overrides: PointerEventInit = {}): PointerEvent {
  return new PointerEvent("pointerdown", {
    pointerId: 7,
    pointerType: "mouse",
    isPrimary: true,
    cancelable: true,
    button: 2,
    buttons: 2,
    clientX: 50,
    clientY: 100,
    ...overrides,
  });
}

function nativeMenu(): MouseEvent {
  return new MouseEvent("contextmenu", { button: 2, cancelable: true, clientX: 50, clientY: 100 });
}
