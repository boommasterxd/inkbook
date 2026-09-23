import { describe, expect, it, vi } from "vitest";
import { domRect } from "../../fixtures/obsidian/active-editor";
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
      expect(h.move).toHaveBeenLastCalledWith(248, 80);
      expect(h.request).not.toHaveBeenCalled();
      expect(h.measure).not.toHaveBeenCalled();
      expect(h.icon).not.toHaveBeenCalled();
      expect(h.controller.lastPagePointer).toBe(page);
      expect(h.controller.lastScreenPointer).toBe(screen);
      expect(h.controls.input).toBe(input);
      expect(h.read().cursor?.x).toBe(248);
      h.controller.dispose();
      h.request.mockClear();
      h.surface.dispatchEvent(sample(200, { pointerType }, "pointerrawupdate"));
      expect(h.move).toHaveBeenCalledTimes(128);
      expect(h.request).not.toHaveBeenCalled();
    },
  );
});

it("bounds layout work to delivered scroll invalidations with interleaved raw input", () => {
  const scrollBounds = vi.fn(() => domRect({ left: 0, top: 0, width: 600, height: 500 }));
  const h = harness({ scrollBounds });
  h.controller.record(sample(1), "move");
  h.read();
  h.measure.mockClear();
  scrollBounds.mockClear();
  h.request.mockClear();
  h.icon.mockClear();
  for (const [scrollIndex, top] of [10, -90, 30, -40].entries()) {
    h.bounds.top = top;
    for (let index = 0; index < 128; index += 1) {
      h.surface.dispatchEvent(
        sample(10 + scrollIndex * 128 + index, { clientX: 121 + index }, "pointerrawupdate"),
      );
    }
    expect(h.measure).toHaveBeenCalledTimes(scrollIndex);
    expect(scrollBounds).toHaveBeenCalledTimes(scrollIndex);
    expect(h.move).toHaveBeenLastCalledWith(248, 80);
    expect(h.read(true).cursor).toMatchObject({ x: 248, y: 80 });
    expect(h.read().cursor).toMatchObject({ x: 248, y: 80 });
  }
  expect(h.measure).toHaveBeenCalledTimes(4);
  expect(scrollBounds).toHaveBeenCalledTimes(4);
  expect(h.icon).toHaveBeenCalledTimes(8);
  expect(h.move).toHaveBeenCalledTimes(512);
  expect(h.request).not.toHaveBeenCalled();
  h.controller.dispose();
});
