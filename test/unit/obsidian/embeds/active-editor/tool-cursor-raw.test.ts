import { describe, expect, it } from "vitest";
import { reduceInput } from "../../../../../src/editor/input";
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
    expect(h.move).toHaveBeenCalledExactlyOnceWith(180, 50);
    h.controller.record(sample(25, { clientX: 170 }), "move");
    expect(h.read().cursor?.x).toBe(180);
    h.controller.record(sample(40, { clientX: 220 }), "move");
    expect(h.read().cursor?.x).toBe(200);
    expect(h.move).toHaveBeenLastCalledWith(200, 50);
    h.controller.dispose();
  });

  it("rejects raw samples older than the latest ordinary position", () => {
    const h = harness();
    h.controller.record(sample(30), "move");
    h.read();
    h.surface.dispatchEvent(raw(20, { clientX: 200 }));
    expect(h.move).not.toHaveBeenCalled();
    expect(h.read().cursor?.x).toBe(100);
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
    expect(h.read().cursor?.x).toBe(180);
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
    expect(h.move).toHaveBeenCalledExactlyOnceWith(160, 50);
    expect(h.read().cursor?.x).toBe(160);
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
    expect(h.read().cursor?.x).toBe(100);
    h.controller.dispose();
  });

  it("ignores non-finite raw timestamps without poisoning later input", () => {
    const h = harness();
    h.controller.record(sample(10), "move");
    h.read();
    h.surface.dispatchEvent(raw(Number.NaN, { clientX: 200 }));
    expect(h.move).not.toHaveBeenCalled();
    expect(h.read().cursor?.x).toBe(100);
    h.surface.dispatchEvent(raw(20, { clientX: 180 }));
    expect(h.move).toHaveBeenCalledExactlyOnceWith(160, 50);
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
    expect(h.read().cursor?.x).toBe(100);
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
