// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import { INTERACTION_REFRESH_PROFILE } from "../../../interaction-refresh-profile";
import { sceneSurfaceZoomFixture } from "../../../../fixtures/rendering/scene-surface-zoom";
import { activeEditorResizePhaseFixture } from "../../../../fixtures/obsidian/active-editor-resize-phase";
import { PAGE_WIDTH } from "../../../../../src/domain/geometry/public";

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

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz host resize ordering`, () => {
  it.each([false, true])(
    "applies an owner clamp with an earlier queued scene=%s",
    (earlierScene) => {
      const h = activeEditorResizePhaseFixture(INTERACTION_REFRESH_PROFILE.frameDurationMs);
      try {
        if (earlierScene) {
          h.mountPresentation();
          h.renderer.invalidateLayout();
        }
        h.queuePresentationClamp();
        h.renderer.invalidateLayout();
        h.frame();

        expect(h.viewport()?.width).toBe(300);
        expect(h.navigation.zoom).toBeCloseTo(300 / PAGE_WIDTH);
        expect(h.camera).toHaveBeenLastCalledWith({ x: 0, zoom: 300 / PAGE_WIDTH });
        h.scheduler.runAll();
        expect(h.sceneCamera()?.zoom).toBeCloseTo(300 / PAGE_WIDTH);
        expect(h.viewport()?.width).toBe(300);
      } finally {
        h.release();
        vi.restoreAllMocks();
      }
    },
  );
});

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz resize measurement phase`, () => {
  it.each([false, true])(
    "shares layout reads after an earlier surface invalidation (scene already queued=%s)",
    (alreadyQueued) => {
      const h = activeEditorResizePhaseFixture(INTERACTION_REFRESH_PROFILE.frameDurationMs);
      try {
        expect(h.initial).toEqual({ cameraWrites: 0, containerReads: 2 });
        const anchoredPageY = (250 - h.box.top) / h.navigation.zoom;
        if (alreadyQueued) h.renderer.invalidateLayout();
        h.resize(800);
        h.resize(800);
        expect(h.scheduler.pendingCount).toBe(1);
        h.frame();

        expect(h.camera).toHaveBeenCalledOnce();
        expectSharedLayoutReadPhase(h.events);
        h.scheduler.runAll();
        expect(h.query.mock.calls.length).toBeLessThanOrEqual(16);
        expect(h.indexed.work.indexedVisits).toBeLessThan(10_000);
        expect(h.indexed.fallback).not.toHaveBeenCalled();
        expect(h.viewport()).toMatchObject({ width: 800 });
        expect(h.camera).toHaveBeenLastCalledWith({
          x: h.navigation.cameraX,
          zoom: h.navigation.zoom,
        });
        expect((250 - h.box.top) / h.navigation.zoom).toBeCloseTo(anchoredPageY);
        expect(h.renderer.instrumentation().scheduledFrames).toBeLessThanOrEqual(2);

        h.reset();
        h.resize(600);
        h.frame();
        expect(h.camera).toHaveBeenCalledOnce();
        h.scheduler.runAll();
        expect(h.viewport()).toMatchObject({ width: 600 });
        expect(h.renderer.instrumentation().scheduledFrames).toBeLessThanOrEqual(2);
        h.resize(500);
      } finally {
        h.release();
        expect(h.scheduler.pendingCount).toBe(0);
        h.events.length = 0;
        h.resize(400);
        expect(h.events).toEqual([]);
        expect(h.scheduler.pendingCount).toBe(0);
        vi.restoreAllMocks();
      }
    },
  );

  it("shares the measured height with content growth before the anchored width write", () => {
    const h = activeEditorResizePhaseFixture(INTERACTION_REFRESH_PROFILE.frameDurationMs);
    try {
      const oldHeight = Number.parseFloat(h.container.style.blockSize);
      h.resize(800);
      h.setMaximumBottom(1000);
      h.frame();
      expectSharedLayoutReadPhase(h.events);
      h.scheduler.runAll();
      expect(Number.parseFloat(h.container.style.blockSize)).toBeGreaterThan(oldHeight);
      expect(h.viewport()?.width).toBe(800);
      expect(h.navigation.zoom).toBeCloseTo(800 / PAGE_WIDTH);
    } finally {
      h.release();
      vi.restoreAllMocks();
    }
  });
});

function expectSharedLayoutReadPhase(events: readonly string[]): void {
  const complete = events.indexOf("layout-complete");
  expect(complete).toBeGreaterThan(0);
  const sceneEnd = events.lastIndexOf("scene-end", complete);
  const phase = events.slice(sceneEnd + 1, complete);
  const firstWrite = phase.findIndex((event) => event.endsWith("-write"));
  expect(firstWrite).toBeGreaterThan(0);
  expect(phase.slice(firstWrite).filter((event) => event.endsWith("-read"))).toEqual([]);
  expect(phase.filter((event) => event === "container-read")).toHaveLength(1);
  expect(phase.filter((event) => event === "style-read")).toHaveLength(1);
  expect(phase.filter((event) => event === "toolbar-read")).toHaveLength(1);
  expect(phase.filter((event) => event === "owner-read")).toHaveLength(1);
}
