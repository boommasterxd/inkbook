import { describe, expect, it, vi } from "vitest";
import type { InkElementV1 } from "../../../../src/domain/schema/public";
import type { SceneContentRenderer } from "../../../../src/rendering/scene/content-renderer";
import type { SceneDom } from "../../../../src/rendering/scene/scene-dom";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { SceneMotionController } from "../../../../src/rendering/scene/scene-motion-controller";
import { ProgressiveElementPreview } from "../../../../src/rendering/scene/progressive-element-preview";
import { FakeDocument, FakeNode, fakeRectangleRecord } from "../../../unit/rendering/scene/fakes";
import { INTERACTION_REFRESH_PROFILE } from "../../interaction-refresh-profile";
import { SCENE_PUBLICATION_ROOTS_PER_FRAME } from "../../../../src/rendering/scene/constants";
import * as fadeStyle from "../../../../src/rendering/scene/element-fade-style";
import {
  createIndexedSceneStore,
  createSceneFixture,
  createViewportRectangleStore,
} from "../../../fixtures/rendering/scene";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import { fakeNode } from "../../../unit/rendering/scene/fakes";

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

it("bounds real fade publication and replay interruption across 10,000 mounted memberships", () => {
  const records = createViewportRectangleStore(10_000, () => 10);
  const indexed = createIndexedSceneStore(records);
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, indexed.store);
  scheduler.runAll(200);
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  const entries = [...records.records.values()];
  const fades = vi.spyOn(fadeStyle, "setElementFadeNode");
  const removals = vi.spyOn(FakeNode.prototype, "remove");
  const style = content.nodes[0]!.style;
  const stylePrototype = Object.getPrototypeOf(style) as typeof style;
  const styles = vi.spyOn(stylePrototype, "removeProperty");
  const properties = vi.spyOn(stylePrototype, "setProperty");
  const replay = (remove: boolean) => {
    if (remove) records.records.clear();
    else for (const entry of entries) records.records.set(entry.id, entry);
    const writes = styles.mock.calls.length;
    const starts = fades.mock.calls.length;
    renderer.applyDelta({
      historyReplay: true,
      affected: entries.map(({ id, element, bounds }) => ({
        id,
        domains: ["visibility"],
        before: remove ? element : null,
        after: remove ? null : element,
        beforeBounds: remove ? bounds : null,
        afterBounds: remove ? null : bounds,
      })),
    });
    expect(fades.mock.calls).toHaveLength(starts);
    expect(styles.mock.calls).toHaveLength(writes);
  };
  const frame = () => {
    const start = fades.mock.calls.length;
    const writes = styles.mock.calls.length;
    const exits = removals.mock.calls.length;
    const roots = renderer.instrumentation().domRootsPublished;
    scheduler.runNext();
    expect(fades.mock.calls.length - start).toBeLessThanOrEqual(128);
    expect(styles.mock.calls.length - writes).toBeLessThanOrEqual(130);
    expect(removals.mock.calls.length - exits).toBeLessThanOrEqual(64);
    expect(renderer.instrumentation().domRootsPublished - roots).toBeLessThanOrEqual(
      SCENE_PUBLICATION_ROOTS_PER_FRAME,
    );
    return fades.mock.calls.slice(start);
  };
  try {
    replay(true);
    expect(frame()).toHaveLength(128);
    expect(renderer.mountedCount).toBe(10_000);
    replay(false);
    expect(frame().every((call) => call[3] === "enter")).toBe(true);
    replay(true);
    const targets = collectReplayFadeTargets(frame, "exit");
    expect(targets.size).toBe(10_000);
    expect(removals).not.toHaveBeenCalled();
    scheduler.time = 399;
    frame();
    expect(renderer.mountedCount).toBe(10_000);
    scheduler.time = 400;
    for (let frames = 0; scheduler.pendingCount > 0; frames += 1) {
      expect(frames).toBeLessThan(200);
      frame();
    }
    expect(renderer.mountedCount).toBe(0);
    replay(false);
    expect(collectReplayFadeTargets(frame, "enter").size).toBe(10_000);
    expect(renderer.mountedCount).toBe(10_000);
    scheduler.time = 799;
    frame();
    expect(content.nodes.every((node) => Boolean(node.style.animation))).toBe(true);
    const propertyWrites = properties.mock.calls.length;
    const interruptedWrites = styles.mock.calls.length;
    const interruptedStarts = fades.mock.calls.length;
    renderer.interruptMotionForPointerDown();
    expect(properties.mock.calls.length - propertyWrites).toBe(2);
    expect(styles.mock.calls).toHaveLength(interruptedWrites);
    expect(fades.mock.calls).toHaveLength(interruptedStarts);
    scheduler.time = 800;
    for (let frames = 0; scheduler.pendingCount > 0; frames += 1) {
      expect(frames).toBeLessThan(100);
      frame();
    }
    expect(content.nodes.every((node) => !node.style.animation && !node.style.visibility)).toBe(
      true,
    );
    expect(renderer.instrumentation()).toMatchObject({ motionTombstones: 0, motionEntrances: 0 });
    expect(indexed.fallback).not.toHaveBeenCalled();
  } finally {
    fades.mockRestore();
    removals.mockRestore();
    styles.mockRestore();
    properties.mockRestore();
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
  expect(renderer.memoryUsage()).toEqual({ pathCacheBytes: 0, motionCacheBytes: 0 });
});

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

  it("visits all entries once with spare budget and discards cancelled iteration state", () => {
    const harness = motionHarness(600);
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

function collectReplayFadeTargets(
  frame: () => Array<Parameters<typeof fadeStyle.setElementFadeNode>>,
  direction: "enter" | "exit",
): Set<SVGElement> {
  const targets = new Set<SVGElement>();
  for (let batch = 0; targets.size < 10_000; batch += 1) {
    expect(batch).toBeLessThan(100);
    for (const call of frame()) {
      expect(call[1]).toBe(400);
      expect(call[3]).toBe(direction);
      targets.add(call[0]);
    }
  }
  return targets;
}
