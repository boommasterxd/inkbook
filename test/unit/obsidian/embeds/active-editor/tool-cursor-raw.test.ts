import { describe, expect, it, vi } from "vitest";
import { createInputState, reduceInput } from "../../../../../src/editor/input";
import { domRect } from "../../../../fixtures/obsidian/active-editor";
import { pointerDown } from "../../../../fixtures/editor/input-actions";
import {
  timedCursorPointerEvent as sample,
  toolCursorHarness as harness,
} from "../../../../fixtures/obsidian/tool-cursor";

function raw(timeStamp: number, overrides: Partial<PointerEvent> = {}): Event {
  return sample(timeStamp, overrides, "pointerrawupdate");
}

describe("raw tool cursor position input", () => {
  it("keeps newer raw coordinates when a delayed normal move arrives", () => {
    const h = harness();
    h.controller.record(sample(10), "move");
    h.read();
    h.surface.dispatchEvent(raw(30, { clientX: 200 }));
    h.surface.dispatchEvent(raw(20, { clientX: 160 }));
    expect(h.move).toHaveBeenCalledExactlyOnceWith(200, 80);
    h.controller.record(sample(25, { clientX: 170 }), "move");
    expect(h.read().cursor?.x).toBe(200);
    h.controller.record(sample(40, { clientX: 220 }), "move");
    expect(h.read().cursor?.x).toBe(220);
    expect(h.move).toHaveBeenLastCalledWith(220, 80);
    h.controller.dispose();
  });

  it("rejects raw samples older than the latest ordinary position", () => {
    const h = harness();
    h.controller.record(sample(30), "move");
    h.read();
    h.surface.dispatchEvent(raw(20, { clientX: 200 }));
    expect(h.move).not.toHaveBeenCalled();
    expect(h.read().cursor?.x).toBe(120);
    h.controller.dispose();
  });

  it("retains raw coordinates before bounds exist without forcing a measurement", () => {
    const h = harness();
    h.controller.record(sample(10), "move");
    h.request.mockClear();
    h.surface.dispatchEvent(raw(20, { clientX: 200 }));
    expect(h.move).not.toHaveBeenCalled();
    expect(h.measure).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.read().cursor?.x).toBe(200);
    h.controller.dispose();
  });

  it("does not use raw touch positions even for the tracked touch pointer", () => {
    const h = harness();
    h.controller.record(sample(10, { pointerType: "touch" }), "move");
    h.read();
    h.request.mockClear();
    h.surface.dispatchEvent(raw(20, { pointerType: "touch", clientX: 200 }));
    expect(h.move).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
    h.read();
    expect(h.controller.lastScreenPointer?.x).toBe(100);
    h.controller.dispose();
  });

  it("preserves normal pointer movement when raw events are unavailable", () => {
    const h = harness();
    h.controller.record(sample(10), "move");
    h.read();
    h.controller.record(sample(20, { clientX: 180 }), "move");
    expect(h.move).toHaveBeenCalledExactlyOnceWith(180, 80);
    expect(h.read().cursor?.x).toBe(180);
    h.controller.dispose();
  });
});

describe("raw tool cursor input exclusion and lifecycle", () => {
  it.each([
    { pointerId: 2 },
    { pointerType: "pen" },
    { pointerType: "touch" },
    { clientX: Number.NaN },
    { clientY: Number.POSITIVE_INFINITY },
  ])("ignores foreign or invalid raw samples %j", (overrides) => {
    const h = harness();
    h.controller.record(sample(10), "move");
    h.read();
    h.request.mockClear();
    h.surface.dispatchEvent(raw(20, { clientX: 200, ...overrides }));
    expect(h.move).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.read().cursor?.x).toBe(120);
    h.controller.dispose();
  });

  it("ignores non-finite raw timestamps without poisoning later input", () => {
    const h = harness();
    h.controller.record(sample(10), "move");
    h.read();
    h.surface.dispatchEvent(raw(Number.NaN, { clientX: 200 }));
    expect(h.move).not.toHaveBeenCalled();
    expect(h.read().cursor?.x).toBe(120);
    h.surface.dispatchEvent(raw(20, { clientX: 180 }));
    expect(h.move).toHaveBeenCalledExactlyOnceWith(180, 80);
    h.controller.dispose();
  });

  it.each(["disabled", "gesture", "handle"])("ignores raw input during %s exclusion", (reason) => {
    const h = harness();
    h.controller.record(sample(10), "move");
    h.read();
    const input = h.controls.input;
    if (reason === "disabled") h.controls.enabled = false;
    if (reason === "gesture")
      h.controls.input = reduceInput(h.controls.input, pointerDown({ pointerId: 2 })).state;
    if (reason === "handle") h.controls.handlePointer = 2;
    h.request.mockClear();
    h.surface.dispatchEvent(raw(20, { clientX: 200 }));
    expect(h.move).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
    h.controls.enabled = true;
    h.controls.input = input;
    expect(h.read().cursor?.x).toBe(120);
    h.controller.dispose();
  });

  it("does not create or resurrect feedback before entry, after departure, or after disposal", () => {
    const h = harness();
    h.request.mockClear();
    h.surface.dispatchEvent(raw(10));
    expect(h.request).not.toHaveBeenCalled();
    h.controller.record(sample(20), "move");
    h.read();
    h.controller.clear();
    h.request.mockClear();
    h.surface.dispatchEvent(raw(30, { clientX: 200 }));
    expect(h.read().cursor).toBeNull();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.move).not.toHaveBeenCalled();
    h.controller.record(sample(40), "move");
    h.read();
    h.controller.dispose();
    h.request.mockClear();
    h.surface.dispatchEvent(raw(50, { clientX: 200 }));
    expect(h.request).not.toHaveBeenCalled();
    expect(h.move).not.toHaveBeenCalled();
    expect(h.read().cursor).toBeNull();
  });
});

describe("tool cursor coordinates during native scrolling", () => {
  it.each(["draw", "eraser"] as const)(
    "keeps %s feedback at the latest client position before and after scroll delivery",
    (activeTool) => {
      const h = harness();
      h.controls.input = createInputState({ activeTool, zoom: 2 });
      h.controls.cameraX = 5;
      h.controller.record(sample(10), "move");
      const initial = h.read().cursor;
      expect(initial).toMatchObject({ x: 120, y: 80 });
      if (activeTool === "eraser")
        expect(initial).toMatchObject({ kind: "eraser", radius: h.defaults.eraser.radius });
      for (const [index, top] of [10, -90, 30, -40].entries()) {
        h.bounds.top = top;
        const time = 20 + index * 10;
        const clientX = 121 + index;
        // Native scrolling moves the canvas before its scroll notification arrives.
        h.surface.dispatchEvent(raw(time + 2, { clientX }));
        expect(h.move).toHaveBeenLastCalledWith(clientX, 80);
        h.controller.record(sample(time + 1, { clientX: clientX - 1 }), "move");
        expect(h.read().cursor).toMatchObject({ x: clientX, y: 80 });
        expect(h.read(true).cursor).toMatchObject({ x: clientX, y: 80 });
        expect(h.controller.lastScreenPointer).toMatchObject({ x: clientX - 20, y: 80 - top });
        expect(h.handleCursor).toHaveBeenLastCalledWith(
          expect.objectContaining({ x: (clientX - 20) / 2 - 5, y: (80 - top) / 2 }),
        );
      }
      h.bounds.top = 100;
      expect(h.read(true).cursor).toBeNull();
      h.move.mockClear();
      h.surface.dispatchEvent(raw(100));
      expect(h.move).not.toHaveBeenCalled();
      h.controller.dispose();
    },
  );
});

it.each([
  {
    left: 0,
    top: 0,
    width: 1000,
    height: 1000,
    clip: { left: 20, top: 30, width: 500, height: 400 },
  },
  {
    left: 50,
    top: 50,
    width: 200,
    height: 200,
    clip: { left: 50, top: 50, width: 200, height: 200 },
  },
  {
    left: 600,
    top: 500,
    width: 100,
    height: 100,
    clip: { left: 600, top: 500, width: 0, height: 0 },
  },
])(
  "clips viewport feedback to the canvas and scrollport intersection %j",
  ({ clip, ...viewport }) => {
    const scrollBounds = vi.fn(() => domRect(viewport));
    const h = harness({ scrollBounds });
    h.controller.record(sample(10), "move");
    expect(h.read().cursor).toMatchObject({ x: 120, y: 80, clip });
    h.controller.dispose();
  },
);
