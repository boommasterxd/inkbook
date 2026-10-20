// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import { INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";
import { sceneSurfaceZoomFixture } from "../../fixtures/rendering/scene-surface-zoom";

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz layout profile`, () => {
  it("bounds owned style writes, resize frames, and foreign theme reads independently", () => {
    const h = sceneSurfaceZoomFixture();
    h.scheduler.frameBudgetMs = INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs;
    try {
      for (let frame = 0; frame < INTERACTION_REFRESH_PROFILE.sampleCount; frame += 1) {
        h.scheduler.time = (frame + 1) * INTERACTION_REFRESH_PROFILE.frameDurationMs;
        const height = frame % 2 === 0 ? 200.25 : 300.75;
        h.zoom(height);
        h.zoom(height);
        h.deliver();
        h.resize(height);
        expect(h.scheduler.pendingCount).toBe(1);
        h.scheduler.runAll();
      }
      const count = INTERACTION_REFRESH_PROFILE.sampleCount;
      expect(h.read).not.toHaveBeenCalled();
      expect(h.writes).toHaveBeenCalledTimes(count);
      expect(h.drawingWrites).toHaveBeenCalledTimes(count);
      expect(h.renderer.instrumentation().scheduledFrames).toBe(count);
      h.foreignStyle(h.container, "--text-normal", "red");
      h.deliver();
      h.scheduler.runAll();
      expect(h.read).toHaveBeenCalledOnce();
      expect(h.drawingWrites).toHaveBeenLastCalledWith("--text-normal", "red");
      h.zoom(400);
      h.release();
      h.deliver();
      h.resize(400);
      expect(h.scheduler.pendingCount).toBe(0);
      expect(h.read).toHaveBeenCalledOnce();
      expect(h.disconnectTheme).toHaveBeenCalledOnce();
      expect(h.disconnectResize).toHaveBeenCalledOnce();
    } finally {
      h.release();
      vi.restoreAllMocks();
    }
  });
});
