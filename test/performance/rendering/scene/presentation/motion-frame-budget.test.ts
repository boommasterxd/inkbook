import { describe, expect, it, vi } from "vitest";
import type { BoxShapeElementV1 } from "../../../../../src/domain/schema/public";
import type { SceneContentRenderer } from "../../../../../src/rendering/scene/content-renderer";
import { ProgressiveElementPreview } from "../../../../../src/rendering/scene/presentation/progressive-element-preview";
import { fakeRectangleRecord } from "../../../../unit/rendering/scene/fakes";
import { createMotionHarness } from "../../../../fixtures/rendering/scene-motion";
import { INTERACTION_REFRESH_PROFILE } from "../../../interaction-refresh-profile";

const BUDGET = INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs;

it(`preserves 120 ms for geometry, entrance, exit, paint and selection at ${INTERACTION_REFRESH_PROFILE.refreshRate} Hz`, () => {
  const { motion, content, dom } = createMotionHarness(1, 0);
  const before = fakeRectangleRecord("0", 0, 0).element as BoxShapeElementV1;
  const after = { ...before, width: before.width + 100 };
  const entrance = fakeRectangleRecord("enter", 1, 0).element;
  const exit = fakeRectangleRecord("exit", 2, 0).element;
  const paint = fakeRectangleRecord("paint", 3, 0).element;
  motion.applyDelta([
    { id: "0", before, after, domains: ["geometry"] },
    { id: "enter", before: null, after: entrance, domains: ["visibility"] },
    { id: "exit", before: exit, after: null, domains: ["visibility"] },
    { id: "paint", before: paint, after: paint, domains: ["paint"] },
  ]);
  motion.bindMountedEntrances(["enter"], 0);
  motion.applySelectionPath("M 0 0 L 10 10", "M 1 1 L 2 2", "accent");
  motion.applySelectionPath(null, null, "accent");
  content.clearElementPreview.mockClear();
  content.applyElementPreview.mockClear();
  const write = (stamp: number) => {
    motion.writeSelectionFeedback(stamp);
    return motion.write(stamp, Infinity, () => 0);
  };
  expect(write(0)).toBe(true);
  const interval = INTERACTION_REFRESH_PROFILE.frameDurationMs;
  const finalFrame = Math.ceil(120 / interval);
  for (let frame = 1; frame < finalFrame; frame += 1) {
    expect(write(frame * interval)).toBe(true);
    expect(dom.motionGroup.nodes).toHaveLength(2);
    expect(dom.selectionOverlayPath.attributes.get("d")).toBe("M 0 0 L 10 10");
    expect(dom.selectionHandlePath.attributes.get("d")).toBe("M 1 1 L 2 2");
    expect(content.clearElementPreview).not.toHaveBeenCalled();
    const preview = content.applyElementPreview.mock.lastCall![0] as BoxShapeElementV1;
    expect(preview.width).toBeGreaterThan(before.width);
    expect(preview.width).toBeLessThan(after.width);
    expect(content.setElementMotion).not.toHaveBeenCalledWith(["enter"], null);
    expect(content.setElementMotion).not.toHaveBeenCalledWith(["paint"], null);
  }
  expect(write(finalFrame * interval)).toBe(false);
  expect(dom.motionGroup.nodes).toHaveLength(0);
  expect(dom.selectionOverlayPath.attributes.get("d")).toBe("");
  expect(dom.selectionHandlePath.attributes.get("d")).toBe("");
  expect(content.clearElementPreview).toHaveBeenCalledExactlyOnceWith("0");
  expect(content.setElementMotion).toHaveBeenCalledWith(["enter"], null);
  expect(content.setElementMotion).toHaveBeenCalledWith(["paint"], null);
  expect(content.applyElementPreview).toHaveBeenCalledTimes(finalFrame + 1);
  expect(motion.cacheMemoryUsage()).toBe(0);
  motion.release();
});

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz optional scene work`, () => {
  it("defers exhausted frames and visits every motion fairly before revisiting", () => {
    const harness = createMotionHarness(600, BUDGET);
    expect(harness.motion.write(0, harness.now(), harness.now)).toBe(true);
    expect(harness.writes).toEqual([]);
    for (let frame = 0; frame < 600; frame += 1) {
      harness.motion.write(
        frame * INTERACTION_REFRESH_PROFILE.frameDurationMs,
        harness.deadline(),
        harness.now,
      );
      expect(harness.writes).toHaveLength(frame + 1);
    }
    expect(new Set(harness.writes).size).toBe(600);
    harness.motion.interruptForPointerDown();
    expect(harness.content.clearElementPreview).toHaveBeenCalledTimes(600);
    expect(harness.motion.write(10_000, harness.deadline(), harness.now)).toBe(false);
    expect(harness.writes).toHaveLength(600);
  });

  it("completes resumed motions against their original start times", () => {
    const harness = createMotionHarness(3, BUDGET);
    for (const stamp of [0, 20, 40]) harness.motion.write(stamp, harness.deadline(), harness.now);
    for (let frame = 0; frame < 5; frame += 1) {
      harness.motion.write(10_000 + frame, harness.deadline(), harness.now);
    }
    expect(harness.content.clearElementPreview).toHaveBeenCalledTimes(3);
    expect(harness.writes).toEqual(["0", "1", "2", "0", "1", "2"]);
    expect(harness.motion.write(11_000, harness.deadline(), harness.now)).toBe(false);
  });

  it("starts the next sweep without an empty frame at the exact work limit", () => {
    const harness = createMotionHarness(256, BUDGET);
    for (const stamp of [0, 16, 32]) {
      harness.writes.length = 0;
      expect(harness.motion.write(stamp, 100, () => 0)).toBe(true);
      expect(harness.writes).toHaveLength(256);
      expect(new Set(harness.writes).size).toBe(256);
    }
    harness.motion.release();
  });

  it("visits all entries once with spare budget and discards cancelled iteration state", () => {
    const harness = createMotionHarness(600, BUDGET);
    harness.motion.write(0, 100, () => 0);
    expect(harness.writes).toHaveLength(600);
    expect(new Set(harness.writes).size).toBe(600);
    harness.motion.write(16, 100, () => 0);
    expect(harness.writes).toHaveLength(1200);
    harness.motion.release();
    expect(harness.motion.write(32, 100, () => 0)).toBe(false);
  });

  it("bounds immediate preview geometry while retaining coherent feedback and continuation", () => {
    let time = 0;
    const content = {
      promoteVisible: vi.fn(),
      applyCanonicalElementPreview: vi.fn(() => true),
      applyPreviewTransform: vi.fn<SceneContentRenderer["applyPreviewTransform"]>(),
    };
    const preview = new ProgressiveElementPreview(content as unknown as SceneContentRenderer);
    const elements = Array.from(
      { length: 256 },
      (_, index) => fakeRectangleRecord(String(index), index, index).element,
    );
    const materialize = vi.fn((id: string) => {
      time += BUDGET;
      return elements[Number(id)];
    });
    preview.set({
      ids: elements.map(({ id }) => id),
      version: 1,
      isImmediate: () => true,
      materialize,
      feedback: { transform: "scale(2)", inverse: "scale(0.5)" },
    });
    preview.writeFeedback(1, 0, () => time);
    expect(materialize).not.toHaveBeenCalled();
    preview.set({
      ids: elements.map(({ id }) => id),
      version: 2,
      isImmediate: () => true,
      materialize,
      feedback: { transform: "scale(2)", inverse: "scale(0.5)" },
    });
    preview.writeFeedback(1, BUDGET, () => time);
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(new Set(content.applyPreviewTransform.mock.calls.map(([id]) => id)).size).toBe(256);
    expect(preview.write(time, () => time)).toBe(true);
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(preview.write(time + BUDGET, () => time)).toBe(true);
    expect(materialize).toHaveBeenCalledTimes(2);
    expect(content.applyCanonicalElementPreview).toHaveBeenCalledTimes(1);
    preview.release();
    expect(preview.write(time + BUDGET, () => time)).toBe(false);
  });
});
