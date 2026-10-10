import { describe, expect, it } from "vitest";
import { createNavigationHarness } from "../../../fixtures/obsidian/navigation";

const midpoint = { x: 500, y: 200 };
const pixelWheel = (deltaY: number) => ({
  clientX: 500,
  clientY: 300,
  ctrlKey: true,
  deltaMode: 0,
  deltaX: 0,
  deltaY,
});

it.each([
  ["wheel", 0],
  ["pinch", 0],
  ["wheel", 1_800],
  ["pinch", 1_800],
] as const)(
  "retains the raw %s anchor while native scroll at %s stays bounded",
  (mode, scrollTop) => {
    const h = createNavigationHarness({
      containerRect: { height: 2_000, left: 0, top: 300 - scrollTop, width: 1_000 },
      ownerScrollHeight: 2_300,
      ownerScrollTop: scrollTop,
    });
    h.navigation.restoreViewState({ cameraX: 0, zoom: 1 });
    if (mode === "wheel") h.navigation.updateWheel({ ...pixelWheel(1_000), clientY: 400 });
    else {
      const point = { x: 500, y: 400 - h.containerRect.top };
      h.navigation.beginPinchScreen(point);
      h.navigation.updatePinchScreen(point, 0.001);
    }
    h.frames.flushOne();
    const raw = (scrollTop + 100) * h.navigation.zoom - 100;
    const maximum = Math.max(0, 2_000 * h.navigation.zoom - 200);
    expect(h.layoutUpdates[h.layoutUpdates.length - 1]?.scrollTop).toBeCloseTo(raw, 12);
    expect(h.owner.scrollTop).toBeCloseTo(Math.max(0, Math.min(maximum, raw)));
    expect(h.frames.pending).toBe(0);
    h.navigation.dispose();
  },
);

describe("direct continuous zoom targets", () => {
  it.each([[-9], [-10, 1], [-20, 11], [-5, 0.5, -5, 0.5]])(
    "retains the net delta when one frame contains %j",
    (...deltas: number[]) => {
      const harness = createNavigationHarness();
      harness.navigation.restoreViewState({ cameraX: -300, zoom: 1 });
      harness.setCamera.mockClear();
      for (const delta of deltas) harness.navigation.updateWheel(pixelWheel(delta));
      expect(harness.frames.pending).toBe(1);
      harness.frames.flushOne();
      expect(harness.navigation.zoom).toBeCloseTo(Math.exp(0.09), 12);
      expect(harness.layoutUpdates[harness.layoutUpdates.length - 1]).toMatchObject({
        scrollTop: harness.owner.scrollTop,
      });
      expect(harness.setCamera).toHaveBeenCalledTimes(1);
      expect(harness.frames.pending).toBe(0);
      harness.navigation.dispose();
    },
  );

  it("combines keyboard and direct input once without adding a continuous tail", () => {
    const harness = createNavigationHarness();
    const fit = harness.navigation.zoom;
    harness.navigation.updateKeyboardStep(1, null);
    harness.navigation.updateWheel(pixelWheel(-120));
    harness.frames.flushOne();
    expect(harness.navigation.zoom).toBeCloseTo(fit * 1.08 * Math.exp(1.2));
    expect(harness.frames.pending).toBe(0);
    harness.navigation.dispose();
  });

  it("applies huge input and its reverse in one frame each at camera limits", () => {
    const harness = createNavigationHarness();
    const fit = harness.navigation.zoom;
    for (const [delta, zoom] of [
      [-Number.MAX_VALUE, 5],
      [Number.MAX_VALUE, fit],
    ]) {
      harness.navigation.updateWheel(pixelWheel(delta!));
      harness.frames.flushOne();
      expect(harness.navigation.zoom).toBeCloseTo(zoom!, 12);
      expect(harness.frames.pending).toBe(0);
    }
    harness.navigation.dispose();
  });
});

describe("absolute touch pinch and midpoint tracking", () => {
  it("follows the latest absolute scale and commits a pending final sample after release", () => {
    const harness = createNavigationHarness();
    const fit = harness.navigation.zoom;
    harness.navigation.beginPinchScreen(midpoint);
    harness.navigation.updatePinchScreen(midpoint, 4);
    harness.frames.flushOne();
    expect(harness.navigation.zoom).toBeCloseTo(fit * 4);
    harness.navigation.updatePinchScreen(midpoint, 3.6);
    harness.navigation.finish();
    harness.frames.flushOne();
    expect(harness.navigation.zoom).toBeCloseTo(fit * 3.6);
    expect(harness.frames.pending).toBe(0);
    harness.navigation.dispose();
  });

  it("moves the same content point with both fingers at unchanged distance", () => {
    const harness = createNavigationHarness();
    harness.navigation.restoreViewState({ cameraX: -300, zoom: 1 });
    const originalScroll = harness.owner.scrollTop;
    harness.navigation.beginPinchScreen(midpoint);
    harness.navigation.updatePinchScreen({ x: 520, y: 220 }, 1);
    harness.frames.flushOne();
    expect(harness.navigation.zoom).toBe(1);
    expect(harness.navigation.cameraX).toBe(-280);
    expect(harness.owner.scrollTop).toBe(originalScroll - 20);
    expect(harness.frames.pending).toBe(0);
    harness.navigation.dispose();
  });

  it("clamps coincident fingers, translation and zoom to native and camera bounds", () => {
    const harness = createNavigationHarness();
    const fit = harness.navigation.zoom;
    harness.navigation.beginPinchScreen(midpoint);
    harness.navigation.updatePinchScreen({ x: -10000, y: 10000 }, 0);
    harness.frames.flushOne();
    expect(harness.navigation.zoom).toBe(fit);
    expect(harness.navigation.cameraX).toBe(0);
    expect(harness.owner.scrollTop).toBe(0);
    harness.navigation.updatePinchScreen(midpoint, Number.MAX_VALUE);
    harness.frames.flushOne();
    expect(harness.navigation.zoom).toBe(5);
    expect(harness.frames.pending).toBe(0);
    harness.navigation.dispose();
  });

  it("restores zoom and navigation on cancellation and releases pending target state", () => {
    const harness = createNavigationHarness();
    const origin = harness.navigation.getViewState();
    const scroll = harness.owner.scrollTop;
    harness.navigation.beginPinchScreen(midpoint);
    harness.navigation.updatePinchScreen(midpoint, 4);
    harness.frames.flushOne();
    harness.navigation.updatePinchScreen(midpoint, 2);
    harness.navigation.revert();
    expect(harness.navigation.getViewState()).toEqual(origin);
    expect(harness.state().zoom).toBe(origin.zoom);
    expect(harness.owner.scrollTop).toBe(scroll);
    expect(harness.frames.pending).toBe(0);
    harness.navigation.dispose();
  });

  it.each(["setZoom", "restoreViewState", "dispose"] as const)(
    "clears a pending direct target on %s",
    (action) => {
      const harness = createNavigationHarness();
      harness.navigation.beginPinchScreen(midpoint);
      harness.navigation.updatePinchScreen(midpoint, 4);
      if (action === "setZoom") harness.navigation.setZoom(1);
      else if (action === "restoreViewState")
        harness.navigation.restoreViewState({ cameraX: -100, zoom: 1 });
      else harness.navigation.dispose();
      expect(harness.frames.pending).toBe(0);
      harness.navigation.dispose();
    },
  );

  it("ignores malformed scale and midpoint samples without scheduling work", () => {
    const harness = createNavigationHarness();
    harness.navigation.beginPinchScreen(midpoint);
    for (const factor of [-1, NaN, Infinity])
      harness.navigation.updatePinchScreen(midpoint, factor);
    harness.navigation.updatePinchScreen({ x: NaN, y: 1 }, 2);
    harness.navigation.beginPinchScreen({ x: 1, y: Infinity });
    expect(harness.frames.pending).toBe(0);
    harness.navigation.revert();
    harness.navigation.dispose();
  });
});
