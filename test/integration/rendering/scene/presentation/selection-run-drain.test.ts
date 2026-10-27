import { afterEach, expect, it, vi } from "vitest";
import {
  moveSelection,
  scaleElement,
} from "../../../../../src/editor/selection/transform/transforms";
import { sceneDeltaEntries } from "../../../../fixtures/rendering/scene";
import { draining, expectCanonical } from "../../../../fixtures/rendering/selection-run-drain";
import {
  commitSelectionMove,
  commitSelectionScale,
  expectSelectionStart,
  fixture,
  fixtureElement,
  startSelectionResize,
} from "../../../../fixtures/rendering/selection-runs";

afterEach(() => vi.restoreAllMocks());

it("finishes a draining resize after deletion and reordered paint without resurrecting retired members", () => {
  const f = draining();
  try {
    const removed = f.selected[f.selected.length - 1]!;
    f.renderer.applyDelta({
      affected: sceneDeltaEntries(f.store.remove([removed.id])!),
    });
    const rearranged = f.selected[f.selected.length - 2]!;
    f.renderer.applyDelta({
      affected: sceneDeltaEntries(f.store.arrange(new Set([rearranged.id]), "send-to-back")!),
    });
    f.scheduler.runAll(1000);
    expect(f.renderer.mountedIds("content")).not.toContain(removed.id);
    expectCanonical(f);
  } finally {
    f.geometry.mockRestore();
    f.renderer.destroy();
    f.port.release();
  }
});

it("culls and reenters a draining cohort with canonical geometry and committed paint order", () => {
  const f = draining();
  try {
    f.renderer.setViewport({
      left: 0,
      top: 100_000,
      width: 2048,
      height: 1000,
    });
    f.scheduler.runAll(1000);
    expect(f.renderer.mountedCount).toBe(0);
    f.renderer.setViewport({ left: 0, top: 0, width: 2048, height: 1000 });
    f.scheduler.runAll(1000);
    expect(f.renderer.mountedCount).toBe(f.elements.length);
    expectCanonical(f);
  } finally {
    f.geometry.mockRestore();
    f.renderer.destroy();
    f.port.release();
  }
});

it("coalesces an overlapping foreign selection Move without losing mixed pressure canonical targets", () => {
  const f = draining();
  try {
    const ids = [f.pens[0]!, f.ids[f.ids.length - 1]!, f.elements[1]!.id];
    const moved = moveSelection(
      ids.map((id) => fixtureElement(f, id)),
      { x: 5, y: 3 },
    );
    f.renderer.setSelectedElements(new Set(ids));
    f.renderer.setPreviewTransform(ids, "translate(5 3)", 2);
    f.renderer.flushPointerFeedbackFrame(f.scheduler.now());
    commitSelectionMove(f, ids, moved);
    f.scheduler.runAll(1000);
    expectCanonical(f);
    for (const e of moved) expect(f.store.get(e.id)?.element).toEqual(e);
  } finally {
    f.geometry.mockRestore();
    f.renderer.destroy();
    f.port.release();
  }
});

it("does not revive a cancelled foreign Move residual when the same mounted cohort is resized again", () => {
  const f = draining();
  try {
    const ids = f.ids.slice(1);
    const selection = new Set(ids);
    f.renderer.setSelectedElements(selection);
    f.renderer.setPreviewTransform(ids, "translate(5 3)", 2);
    f.renderer.flushPointerFeedbackFrame(f.scheduler.now());
    f.scheduler.runAll(1000);
    f.renderer.clearPreviewTransforms();
    f.renderer.flushPointerFeedbackFrame(f.scheduler.now());
    f.scheduler.runAll(1000);
    const values = ids.map((id) =>
      scaleElement(fixtureElement(f, id), { x: 0, y: 0 }, { x: 2, y: 1 }),
    );
    const byId = new Map(values.map((e) => [e.id, e]));
    f.renderer.setProgressiveElementPreviews(ids, (id) => byId.get(id), 3, {
      ...f.feedback,
      selection,
      selectionSize: ids.length,
    });
    f.renderer.flushPointerFeedbackFrame(f.scheduler.now());
    f.scheduler.runAll(1000);
    const handoff = f.renderer.beginPreviewCommit();
    expect(handoff.arm(ids)).toBe(true);
    f.renderer.clearProgressiveElementPreviews();
    f.renderer.applyDelta({
      affected: sceneDeltaEntries(f.store.replaceMany(values)!),
    });
    f.scheduler.runAll(1000);
    expectCanonical(f);
    expectSelectionStart(f, values[values.length - 1]!);
  } finally {
    f.geometry.mockRestore();
    f.renderer.destroy();
    f.port.release();
  }
});

it("cancels a live resize back to canonical geometry and releases draining ownership on dispose", () => {
  const f = fixture();
  try {
    const stableMemory = f.renderer.memoryUsage().pathCacheBytes;
    startSelectionResize(f);
    f.renderer.clearProgressiveElementPreviews();
    f.scheduler.runAll();
    expectCanonical(f);
    expect(f.renderer.memoryUsage().pathCacheBytes).toBeLessThanOrEqual(stableMemory);
    f.renderer.setProgressiveElementPreviews(f.ids, f.materialize, 2, f.feedback);
    f.renderer.flushPointerFeedbackFrame(f.scheduler.now());
    commitSelectionScale(f, 2);
    expect(f.scheduler.pendingCount).toBeGreaterThan(0);
    f.renderer.destroy();
    expect(f.scheduler.pendingCount).toBe(0);
    expect(f.renderer.mountedCount).toBe(0);
    expect(f.renderer.memoryUsage().motionCacheBytes).toBe(0);
    expect(f.renderer.memoryUsage().pathCacheBytes).toBeLessThan(stableMemory);
  } finally {
    f.renderer.destroy();
    f.port.release();
  }
});
