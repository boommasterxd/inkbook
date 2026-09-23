import { describe, expect, it } from "vitest";
import {
  timedCursorPointerEvent as sample,
  toolCursorHarness as harness,
} from "../../fixtures/obsidian/tool-cursor";

// The controller boundary uses retained renderer methods; dense scene work is
// independently bounded by the 10,000-element scene cursor contract.
describe("raw tool cursor input work bounds", () => {
  it.each(["mouse", "pen"])(
    "moves the retained %s decoration without frame, layout, icon, or session work",
    (pointerType) => {
      const h = harness();
      h.controller.record(sample(10, { pointerType }), "move");
      h.read();
      const page = h.controller.lastPagePointer;
      const screen = h.controller.lastScreenPointer;
      const input = h.controls.input;
      h.request.mockClear();
      h.measure.mockClear();
      h.icon.mockClear();
      for (let index = 0; index < 128; index += 1)
        h.surface.dispatchEvent(
          sample(20 + index, { pointerType, clientX: 121 + index }, "pointerrawupdate"),
        );
      expect(h.move).toHaveBeenCalledTimes(128);
      expect(h.move).toHaveBeenLastCalledWith(228, 50);
      expect(h.request).not.toHaveBeenCalled();
      expect(h.measure).not.toHaveBeenCalled();
      expect(h.icon).not.toHaveBeenCalled();
      expect(h.controller.lastPagePointer).toBe(page);
      expect(h.controller.lastScreenPointer).toBe(screen);
      expect(h.controls.input).toBe(input);
      expect(h.read().cursor?.x).toBe(228);
      h.controller.dispose();
      h.request.mockClear();
      h.surface.dispatchEvent(sample(200, { pointerType }, "pointerrawupdate"));
      expect(h.move).toHaveBeenCalledTimes(128);
      expect(h.request).not.toHaveBeenCalled();
    },
  );
});
