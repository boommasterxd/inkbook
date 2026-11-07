// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSceneInputHandlers } from "../../../../../../src/obsidian/embeds/active-scene/active-scene-input";
import { installObsidianDomHelpers } from "../../../../../adapters/obsidian/dom";
import { createHarness } from "../../../../../fixtures/obsidian/active-controller";
import { FrameHarness } from "../../../../../fixtures/obsidian/navigation";

beforeEach(() => installObsidianDomHelpers());
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  vi.restoreAllMocks();
});

function createWheelHarness() {
  const frames = new FrameHarness();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(frames.window.requestAnimationFrame);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(frames.window.cancelAnimationFrame);
  const h = createHarness();
  h.controller.setEnabled(true);
  h.controller.setZoom(1);
  const handler = createSceneInputHandlers(() => h.controller).wheel!;
  h.input.addEventListener("wheel", handler);
  const wheel = (deltaY: number, options: WheelEventInit = {}) => {
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 400,
      clientY: 300,
      ctrlKey: true,
      deltaMode: 0,
      deltaY,
      ...options,
    });
    // Happy DOM's WheelEvent omits the browser's inherited MouseEvent fields.
    Object.defineProperties(event, {
      clientX: { value: 400 },
      clientY: { value: 300 },
      ctrlKey: { value: options.ctrlKey ?? true },
      metaKey: { value: options.metaKey ?? false },
      shiftKey: { value: false },
    });
    h.input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  };
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    h.input.removeEventListener("wheel", handler);
    h.dispose();
  };
  cleanup.push(dispose);
  return { ...h, frames, wheel, dispose };
}

describe("observed keyboard modifier wheel zoom", () => {
  it.each(["Control", "Meta"])(
    "calibrates held %s scroll and preserves its pointer anchor",
    (key) => {
      const h = createWheelHarness();
      const modifier = key === "Control" ? { ctrlKey: true } : { ctrlKey: false, metaKey: true };
      // Capture on the owning window also observes keys pressed outside the canvas.
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, ...modifier }),
      );
      h.wheel(-100, modifier);
      expect(h.frames.pending).toBe(1);
      h.frames.flushOne();
      expect(h.controller.getViewState().zoom).toBeCloseTo(1.12);
      expect(h.controller.getViewState().cameraX).toBeCloseTo(400 / 1.12 - 400);
      expect(h.frames.pending).toBe(0);
      h.dispose();
    },
  );

  it("retains exact synthetic pinch scaling for small and large pixel deltas", () => {
    const h = createWheelHarness();
    for (const delta of [-4, -100]) {
      h.controller.setZoom(1);
      h.wheel(delta);
      h.frames.flushOne();
      expect(h.controller.getViewState().zoom).toBeCloseTo(Math.exp(-delta / 100));
      expect(h.frames.pending).toBe(0);
    }
    h.dispose();
  });

  it.each(["keyup", "blur"])("restores unknown-state pinch mapping after %s", (reset) => {
    const h = createWheelHarness();
    h.key("Control", { ctrlKey: true });
    if (reset === "keyup") window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
    else window.dispatchEvent(new Event("blur"));
    h.wheel(-100);
    h.frames.flushOne();
    expect(h.controller.getViewState().zoom).toBeCloseTo(Math.E);
    h.dispose();
  });

  it("coalesces partitions and reversals without replaying earlier modifier-scroll deltas", () => {
    const h = createWheelHarness();
    h.key("Control", { ctrlKey: true });
    for (const delta of [-40, -80, 20]) h.wheel(delta);
    expect(h.frames.pending).toBe(1);
    h.frames.flushOne();
    expect(h.controller.getViewState().zoom).toBeCloseTo(1.12);
    expect(h.frames.pending).toBe(0);
    h.wheel(100);
    h.frames.flushOne();
    expect(h.controller.getViewState().zoom).toBeCloseTo(1);
    expect(h.frames.pending).toBe(0);
    h.dispose();
  });

  it("removes every owned modifier listener and discards held state on recreation", () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const first = createWheelHarness();
    first.key("Control", { ctrlKey: true });
    first.dispose();
    for (const type of ["keydown", "keyup", "blur"]) {
      const calls = added.mock.calls.filter(([name]) => name === type);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(removed.mock.calls).toContainEqual(call);
    }
    const next = createWheelHarness();
    next.wheel(-100);
    next.frames.flushOne();
    expect(next.controller.getViewState().zoom).toBeCloseTo(Math.E);
    next.dispose();
  });
});
