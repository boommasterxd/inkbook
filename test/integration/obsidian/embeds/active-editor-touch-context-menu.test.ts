// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { createHarness } from "../../../fixtures/obsidian/active-controller";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";

beforeEach(() => {
  installObsidianDomHelpers();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("touch long-press context menu", () => {
  it.each(["touch", "compatibility", "pen"])(
    "keeps one menu when a native %s contextmenu follows the long press",
    (source) => {
      const harness = createHarness();
      try {
        if (source === "pen") harness.selectElement();
        const pointer = contact(source === "pen" ? "pen" : "touch");
        harness.controller.handlePointerDown(pointer);
        vi.advanceTimersByTime(500);
        expect(harness.menu.positions).toHaveLength(1);
        const close = vi.spyOn(harness.menu, "close");
        const subscribe = vi.spyOn(harness.menu, "onHide");
        for (const released of [false, true]) {
          if (released) harness.controller.handlePointerUp(pointer);
          const event = new PointerEvent("contextmenu", {
            cancelable: true,
            pointerType: source === "compatibility" ? "mouse" : source,
            clientX: 100,
            clientY: 150,
          });
          if (source === "compatibility")
            Object.defineProperty(event, "sourceCapabilities", {
              value: { firesTouchEvents: true },
            });
          harness.controller.handleContextMenu(event);
          expect(event.defaultPrevented).toBe(true);
          expect(harness.menu.positions).toHaveLength(1);
          expect(close).not.toHaveBeenCalled();
          expect(subscribe).not.toHaveBeenCalled();
        }
        const mouse = new PointerEvent("contextmenu", {
          cancelable: true,
          pointerType: "mouse",
          clientX: 100,
          clientY: 150,
        });
        harness.controller.handleContextMenu(mouse);
        expect(close).toHaveBeenCalledOnce();
        expect(subscribe).toHaveBeenCalledOnce();
        expect(mouse.defaultPrevented).toBe(true);
      } finally {
        harness.dispose();
      }
    },
  );
});

describe("pen selection long press", () => {
  it.each([false, true])("opens after 500ms with selected=%s and harmless jitter", (selected) => {
    const h = createHarness();
    const hit = vi.spyOn(ElementSceneStore.prototype, "hit");
    try {
      h.controller.handleToolbarAction("select");
      if (selected) h.selectElement();
      h.renderer.setPreviewTransform.mockClear();
      h.renderer.setSelectedElements.mockClear();
      hit.mockClear();
      const x = selected ? 100 : 50;
      const y = selected ? 150 : 100;
      h.controller.handlePointerDown(contact("pen", { clientX: x, clientY: y }));
      h.controller.handlePointerMove(contact("pen", { clientX: x + 3, clientY: y }));
      vi.advanceTimersByTime(499);
      expect(h.menu.positions).toHaveLength(0);
      expect(h.renderer.setPreviewTransform).not.toHaveBeenCalled();
      expect(hit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(h.menu.positions).toHaveLength(1);
      if (!selected) expect(h.renderer.setSelectedElements.mock.lastCall?.[0].size).toBe(1);
      expect(hit).toHaveBeenCalledTimes(selected ? 0 : 1);
      if (!selected) expect(hit.mock.lastCall?.[0]).toEqual({ x, y });
      expect(h.capture.release).toHaveBeenCalledWith(7);
      h.controller.handlePointerMove(contact("pen", { clientX: 140 }));
      h.controller.handlePointerUp(contact("pen", { pressure: 0, buttons: 0, clientX: 140 }));
      vi.advanceTimersByTime(500);
      expect(h.menu.positions).toHaveLength(1);
      expect(h.renderer.setPreviewTransform).not.toHaveBeenCalled();
    } finally {
      hit.mockRestore();
      h.dispose();
    }
  });

  it.each(["cancel", "drag"])("cancels the menu timer on %s", (terminal) => {
    const h = createHarness();
    try {
      h.selectElement();
      h.controller.handlePointerDown(contact("pen"));
      if (terminal === "cancel") h.controller.handlePointerCancel(contact("pen"));
      else {
        h.controller.handlePointerMove(contact("pen", { clientX: 108 }));
        vi.advanceTimersByTime(20);
        expect(h.renderer.setPreviewTransform).toHaveBeenCalled();
        h.controller.handlePointerCancel(contact("pen"));
      }
      vi.advanceTimersByTime(500);
      expect(h.menu.positions).toHaveLength(0);
    } finally {
      h.dispose();
    }
  });
});

describe("long-press touch terminal recovery", () => {
  it.each(["pointerup", "pointercancel"])(
    "recovers %s outside the canvas without closing the menu",
    (terminal) => {
      const h = createHarness();
      try {
        h.selectElement();
        h.controller.handlePointerDown(contact("touch"));
        vi.advanceTimersByTime(500);
        expect(h.menu.positions).toHaveLength(1);
        const close = vi.spyOn(h.menu, "close");
        h.capture.release.mockClear();
        document.body.dispatchEvent(
          new PointerEvent(terminal, {
            bubbles: true,
            pointerType: "touch",
            pointerId: 8,
            buttons: 0,
          }),
        );
        vi.advanceTimersByTime(0);
        expect(h.capture.release).not.toHaveBeenCalled();
        document.body.dispatchEvent(
          new PointerEvent(terminal, {
            bubbles: true,
            pointerType: "touch",
            pointerId: 7,
            buttons: 0,
          }),
        );
        vi.advanceTimersByTime(0);
        expect(close).not.toHaveBeenCalled();
        expect(h.menu.positions).toHaveLength(1);
        expect(h.renderer.setPreviewTransform).not.toHaveBeenCalled();
        h.menu.close();
        h.input.focus();
        h.key("Escape");
        expect(h.renderer.setSelectedElements.mock.lastCall?.[0].size).toBe(0);
      } finally {
        h.dispose();
      }
    },
  );
});

function contact(pointerType: string, overrides: PointerEventInit = {}): PointerEvent {
  return new PointerEvent("pointerdown", {
    pointerType,
    pointerId: 7,
    isPrimary: true,
    buttons: 1,
    button: 0,
    clientX: 100,
    clientY: 150,
    pressure: 0.5,
    ...overrides,
  });
}
