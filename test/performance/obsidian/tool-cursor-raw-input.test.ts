import { navigationCursorFixture } from "../../fixtures/obsidian/navigation-cursor";
import { describe, expect, it, vi } from "vitest";
import { domRect } from "../../fixtures/obsidian/active-editor";
import { readActiveSceneLayout } from "../../../src/obsidian/embeds/active-scene-viewport";
import {
  timedCursorPointerEvent as sample,
  toolCursorHarness as harness,
} from "../../fixtures/obsidian/tool-cursor";

// The controller boundary uses retained renderer methods; dense scene work is
// independently bounded by the 10,000-element scene cursor contract.
it("shares each native-scroll layout read across scene and cursor without another frame request", () => {
  const { h, events, container, owner, navigation } = navigationCursorFixture("select", "mouse");
  h.read();
  h.measure.mockClear();
  h.window.getComputedStyle.mockClear();
  h.request.mockClear();
  events.length = 0;
  for (const top of [10, -90, 30, -40]) {
    h.bounds.top = top;
    const snapshot = readActiveSceneLayout(container, owner);
    h.controller.adoptSceneLayout(snapshot.cursorLayout);
    expect(h.read(true).cursor).toMatchObject({ x: 120, y: 80 });
    expect(h.read().cursor).toMatchObject({ x: 120, y: 80 });
  }
  expect(h.measure).toHaveBeenCalledTimes(4);
  expect(h.window.getComputedStyle).toHaveBeenCalledTimes(4);
  expect(events.filter((event) => event === "owner-box")).toHaveLength(4);
  expect(h.request).not.toHaveBeenCalled();
  navigation.dispose();
  h.controller.dispose();
});
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

it.each([2, 4, 32])("retains hover geometry across pen button %s press and release", (buttons) => {
  const h = harness();
  const input = h.controls.input;
  h.controller.record(sample(1, { pointerType: "pen" }), "move");
  expect(h.read().cursor?.kind).toBe("tool");
  h.measure.mockClear();
  h.icon.mockClear();
  h.request.mockClear();
  try {
    for (const [index, held] of [buttons, 0].entries()) {
      const time = 10 + index * 200;
      h.controller.record(sample(time, { pointerType: "pen", buttons: held }), "move");
      expect(h.request).toHaveBeenCalledOnce();
      if (held === 0) h.flushTimers();
      expect(h.read().cursor?.kind).toBe(held === 0 ? "tool" : "eraser");
      // Releasing restores the existing tool icon; the eraser needs no icon lookup.
      expect(h.icon).toHaveBeenCalledTimes(held === 0 ? 1 : 0);
      h.request.mockClear();
      h.icon.mockClear();
      h.move.mockClear();
      for (let position = 0; position < 128; position += 1)
        h.surface.dispatchEvent(
          sample(
            time + position + 1,
            {
              pointerType: "pen",
              buttons: held,
              clientX: 121 + position,
            },
            "pointerrawupdate",
          ),
        );
      expect(h.move).toHaveBeenCalledTimes(128);
      expect(h.request).not.toHaveBeenCalled();
      expect(h.icon).not.toHaveBeenCalled();
      expect(h.measure).not.toHaveBeenCalled();
      expect(h.controls.input).toBe(input);
    }
  } finally {
    h.controller.dispose();
  }
});

it("owns one pen release timer across hover moves and cancels it on repress and disposal", () => {
  const h = harness();
  try {
    h.controller.record(sample(1, { pointerType: "pen", buttons: 2 }), "move");
    expect(h.read().cursor?.kind).toBe("eraser");
    h.measure.mockClear();
    h.controller.record(sample(2, { pointerType: "pen", buttons: 0 }), "up");
    expect(h.window.setTimeout).toHaveBeenCalledOnce();
    expect(h.window.setTimeout.mock.calls[0]?.[1]).toBe(300);
    expect(h.timers.size).toBe(1);
    for (let position = 0; position < 128; position += 1)
      h.controller.record(
        sample(3 + position, {
          pointerType: "pen",
          buttons: 0,
          clientX: 121 + position,
        }),
        "move",
      );
    expect(h.read().cursor?.kind).toBe("eraser");
    expect(h.window.setTimeout).toHaveBeenCalledOnce();
    expect(h.window.clearTimeout).not.toHaveBeenCalled();
    expect(h.measure).not.toHaveBeenCalled();
    expect(h.icon).not.toHaveBeenCalled();
    expect(h.timers.size).toBe(1);

    h.controller.record(sample(200, { pointerType: "pen", buttons: 2 }), "move");
    expect(h.window.clearTimeout).toHaveBeenCalledOnce();
    expect(h.timers.size).toBe(0);
    h.controller.record(sample(201, { pointerType: "pen", buttons: 0 }), "up");
    expect(h.window.setTimeout).toHaveBeenCalledTimes(2);
    expect(h.timers.size).toBe(1);
    h.controller.dispose();
    expect(h.window.clearTimeout).toHaveBeenCalledTimes(2);
    expect(h.timers.size).toBe(0);
    h.request.mockClear();
    h.flushTimers();
    expect(h.request).not.toHaveBeenCalled();
  } finally {
    h.controller.dispose();
  }
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

it("coalesces zoom bursts into one measured layout and no post-write cursor geometry read", () => {
  const { h, frames, events, navigation } = navigationCursorFixture("draw", "mouse");
  for (let index = 0; index < 128; index += 1)
    navigation.updateWheel({
      clientX: 120,
      clientY: 80,
      ctrlKey: true,
      deltaMode: 0,
      deltaY: -0.01,
    });
  expect(frames.pendingCount).toBe(1);
  frames.runNext(10);
  expect(h.measure).toHaveBeenCalledTimes(1);
  expect(h.window.getComputedStyle).toHaveBeenCalledTimes(1);
  expect(events.filter((event) => event === "owner-box")).toHaveLength(1);
  expect(
    events
      .slice(events.indexOf("height-write"))
      .filter((event) => event === "box" || event === "style" || event === "owner-box"),
  ).toEqual([]);
  navigation.dispose();
  h.controller.dispose();
  expect(frames.pendingCount).toBe(0);
});
