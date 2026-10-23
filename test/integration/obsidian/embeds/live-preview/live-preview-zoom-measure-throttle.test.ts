// @vitest-environment happy-dom

import { expect, it, vi } from "vitest";
import {
  cancelZoomScrollForReason,
  createLivePreviewZoomGeometryFixture,
  createLivePreviewZoomScrollFixture,
  queueTrailingZoomTarget,
  retainMeasuredZoomTarget,
  ZOOM_SCROLL_CANCELLATION_REASONS,
} from "../../../../fixtures/obsidian/live-preview-zoom-scroll";

it("keeps the final latest target without measuring before 150 ms or bypassing admission", () => {
  const h = createLivePreviewZoomGeometryFixture();
  const admission = vi.spyOn(h.scheduler, "requestFrame");
  const geometry = h.geometry;
  try {
    retainMeasuredZoomTarget(h, 812);
    admission.mockClear();
    h.binding.retain(h.owner, 900, { container: h.root, contentTop: 300 });
    h.advance(149);
    h.binding.retain(h.owner, 1_050, { container: h.root, contentTop: 310 });
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.pendingTimers).toBe(1);
    expect(h.frames.pending).toBe(0);
    expect(geometry).not.toHaveBeenCalled();
    h.advance(1);
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.pendingTimers).toBe(0);
    expect(admission).toHaveBeenCalledOnce();
    expect(h.frames.pending).toBe(1);
    h.frames.flushOne();
    expect(h.request).toHaveBeenCalledTimes(2);
    h.measure();
    h.owner.scrollTop = 1_500;
    h.notify();
    expect(h.owner.scrollTop).toBe(1_080);
    expect(geometry).toHaveBeenCalledOnce();
    expect(h.pendingTimers + h.frames.pending).toBe(0);
  } finally {
    h.destroy();
  }
});

it("keeps the latest keyed target when the host has not yet read the first measurement", () => {
  const h = createLivePreviewZoomScrollFixture();
  try {
    h.binding.retain(h.owner, 800);
    h.advance(200);
    h.binding.retain(h.owner, 1_000);
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.pendingTimers + h.frames.pending).toBe(0);
    h.measure();
    h.owner.scrollTop = 1_500;
    h.notify();
    expect(h.owner.scrollTop).toBe(1_000);
  } finally {
    h.destroy();
  }
});

it("corrects drift observed before a trailing empty measurement without a host update", () => {
  const h = createLivePreviewZoomGeometryFixture();
  const geometry = h.geometry;
  try {
    retainMeasuredZoomTarget(h, 800);
    h.binding.retain(h.owner, 1_000, { container: h.root, contentTop: 300 });
    h.owner.scrollTop = 1_500;
    h.notify();
    expect(h.owner.scrollTop).toBe(1_500);
    expect(geometry).not.toHaveBeenCalled();
    h.advance(150);
    h.frames.flushOne();
    h.measure();
    expect(h.frames.pending).toBe(1);
    expect(geometry).not.toHaveBeenCalled();
    h.frames.flushOne();
    expect(h.owner.scrollTop).toBe(1_040);
    expect(geometry).toHaveBeenCalledOnce();
    expect(h.pendingTimers + h.frames.pending).toBe(0);
    h.scrollWrite.mockClear();
    h.notify();
    expect(h.scrollWrite).not.toHaveBeenCalled();
    expect(geometry).toHaveBeenCalledOnce();
  } finally {
    h.destroy();
  }
});

it.each(["timer", "admission"])("cancels trailing work while waiting for %s", (stage) => {
  const h = createLivePreviewZoomScrollFixture();
  try {
    queueTrailingZoomTarget(h);
    if (stage === "admission") h.advance(150);
    h.binding.cancel();
    expect(h.pendingTimers + h.frames.pending).toBe(0);
    h.advance(1_000);
    expect(h.request).toHaveBeenCalledOnce();
    h.owner.scrollTop = 1_500;
    h.notify();
    expect(h.owner.scrollTop).toBe(1_500);
  } finally {
    h.destroy();
  }
});

it.each(ZOOM_SCROLL_CANCELLATION_REASONS)("cancels deferred host measurement on %s", (reason) => {
  const h = createLivePreviewZoomScrollFixture();
  try {
    queueTrailingZoomTarget(h);
    cancelZoomScrollForReason(h, reason);
    h.advance(1_000);
    if (reason === "detach") h.frames.flushOne();
    expect(h.request.mock.calls.filter(([measure]) => measure !== undefined)).toHaveLength(1);
    expect(h.pendingTimers + h.frames.pending).toBe(0);
  } finally {
    h.destroy();
  }
});
