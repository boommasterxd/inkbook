import { describe, expect, it, vi } from "vitest";
import type { InkElementV1 } from "../../../../src/domain/schema/public";
import type { SceneContentRenderer } from "../../../../src/rendering/scene/content-renderer";
import type { SceneDom } from "../../../../src/rendering/scene/scene-dom";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { SceneMotionController } from "../../../../src/rendering/scene/scene-motion-controller";
import { ProgressiveElementPreview } from "../../../../src/rendering/scene/progressive-element-preview";
import { FakeDocument, FakeNode, fakeRectangleRecord } from "../../../unit/rendering/scene/fakes";
import { INTERACTION_REFRESH_PROFILE } from "../../interaction-refresh-profile";

const BUDGET = INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs;

function motionHarness(count: number) {
  let time = 0;
  const writes: string[] = [];
  const content = {
    hasMounted: () => true,
    applyElementPreview: (element: InkElementV1) => {
      writes.push(element.id);
      time += BUDGET;
    },
    clearElementPreview: vi.fn(),
    setElementMotion: vi.fn(),
  };
  const document = new FakeDocument();
  const motion = new SceneMotionController(
    {
      selectionOverlayPath: new FakeNode(document, "path"),
      selectionHandlePath: new FakeNode(document, "path"),
    } as unknown as SceneDom,
    content as unknown as SceneContentRenderer,
    createInstrumentation(),
    false,
  );
  motion.applyDelta(
    Array.from({ length: count }, (_, index) => {
      const element = fakeRectangleRecord(String(index), index, index).element;
      return { id: element.id, before: element, after: element, domains: ["geometry"] as const };
    }),
  );
  writes.length = 0;
  return { motion, content, writes, now: () => time, deadline: () => time + BUDGET };
}

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz optional scene work`, () => {
  it("defers exhausted frames and visits every motion fairly before revisiting", () => {
    const harness = motionHarness(600);
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
    const harness = motionHarness(3);
    for (const stamp of [0, 20, 40]) harness.motion.write(stamp, harness.deadline(), harness.now);
    for (let frame = 0; frame < 5; frame += 1) {
      harness.motion.write(10_000 + frame, harness.deadline(), harness.now);
    }
    expect(harness.content.clearElementPreview).toHaveBeenCalledTimes(3);
    expect(harness.writes).toEqual(["0", "1", "2", "0", "1", "2"]);
    expect(harness.motion.write(11_000, harness.deadline(), harness.now)).toBe(false);
  });

  it("starts the next sweep without an empty frame at the exact work limit", () => {
    const harness = motionHarness(256);
    for (const stamp of [0, 16, 32]) {
      harness.writes.length = 0;
      expect(harness.motion.write(stamp, 100, () => 0)).toBe(true);
      expect(harness.writes).toHaveLength(256);
      expect(new Set(harness.writes).size).toBe(256);
    }
    harness.motion.release();
  });

  it("caps work with a stationary clock and discards cancelled iteration state", () => {
    const harness = motionHarness(600);
    harness.motion.write(0, 100, () => 0);
    expect(harness.writes).toHaveLength(256);
    harness.motion.write(16, 100, () => 0);
    expect(harness.writes).toHaveLength(512);
    expect(new Set(harness.writes).size).toBe(512);
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
    expect(content.applyCanonicalElementPreview).toHaveBeenCalledTimes(2);
    preview.release();
    expect(preview.write(time + BUDGET, () => time)).toBe(false);
  });
});
