// @vitest-environment happy-dom

import { expect, it, vi } from "vitest";
import { createLivePreviewZoomGeometryFixture } from "../../fixtures/obsidian/live-preview-zoom-scroll";
import { INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";

it("bounds real host measurements and geometry reads during continuous zoom and final settlement", () => {
  const h = createLivePreviewZoomGeometryFixture(300);
  const geometry = h.geometry;
  const admission = vi.spyOn(h.scheduler, "requestFrame");
  const interval = INTERACTION_REFRESH_PROFILE.frameDurationMs;
  const duration = 30_000;
  const samples = Math.ceil(duration / interval);
  let target = 800;
  try {
    for (let sample = 0; sample < samples; sample += 1) {
      target = 800 + sample;
      h.binding.retain(h.owner, target, { container: h.root, contentTop: 300 });
      h.advance(interval);
      if (h.frames.pending !== 0) h.frames.flushOne();
      h.measure();
      h.owner.scrollTop = 1_500;
      h.notify();
      expect(h.pendingTimers + h.frames.pending).toBeLessThanOrEqual(1);
    }
    h.advance(150);
    if (h.frames.pending !== 0) h.frames.flushOne();
    h.measure();
    h.owner.scrollTop = 1_500;
    h.notify();
    expect(h.owner.scrollTop).toBe(target);
    const measurements = h.request.mock.calls.filter(([measure]) => measure !== undefined).length;
    expect(measurements).toBeGreaterThan(1);
    expect(measurements).toBeLessThanOrEqual(Math.ceil(duration / 150) + 1);
    expect(geometry).toHaveBeenCalledTimes(measurements);
    // One production scroll read and one read in the geometry test adapter per
    // settlement, plus the final result assertion above.
    expect(h.scrollRead).toHaveBeenCalledTimes(measurements * 2 + 1);
    expect(admission).toHaveBeenCalledTimes(measurements * 2 - 1);
    expect(h.pendingTimers + h.frames.pending).toBe(0);
    h.binding.retain(h.owner, 2_000);
    h.binding.dispose();
    h.advance(150);
    expect(h.pendingTimers + h.frames.pending).toBe(0);
    expect(h.request.mock.calls.filter(([measure]) => measure !== undefined)).toHaveLength(
      measurements,
    );
  } finally {
    h.destroy();
  }
});
