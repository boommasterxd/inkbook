// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { createHarness } from "../../../fixtures/obsidian/active-controller";

beforeEach(() => {
  installObsidianDomHelpers();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("touch long-press context menu", () => {
  it.each(["touch", "compatibility"])(
    "keeps one menu when a native %s contextmenu follows the long press",
    (source) => {
      const harness = createHarness();
      try {
        const pointer = new PointerEvent("pointerdown", {
          pointerType: "touch",
          pointerId: 7,
          isPrimary: true,
          buttons: 1,
          button: 0,
          clientX: 100,
          clientY: 150,
          pressure: 0.5,
        });
        harness.controller.handlePointerDown(pointer);
        vi.advanceTimersByTime(500);
        expect(harness.menu.positions).toHaveLength(1);
        const close = vi.spyOn(harness.menu, "close");
        const subscribe = vi.spyOn(harness.menu, "onHide");
        for (const released of [false, true]) {
          if (released) harness.controller.handlePointerUp(pointer);
          const event = new PointerEvent("contextmenu", {
            cancelable: true,
            pointerType: source === "touch" ? "touch" : "mouse",
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
