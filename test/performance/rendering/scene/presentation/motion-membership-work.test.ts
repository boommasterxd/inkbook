import { expect, it, vi } from "vitest";
import { activeFades } from "../../../../fixtures/rendering/scene-fades";
import { SCENE_PUBLICATION_ROOTS_PER_FRAME } from "../../../../../src/rendering/scene/constants";
import * as fadeStyle from "../../../../../src/rendering/scene/presentation/element-fade-style";
import {
  createIndexedSceneStore,
  createSceneFixture,
  createViewportRectangleStore,
} from "../../../../fixtures/rendering/scene";
import { createMotionHarness } from "../../../../fixtures/rendering/scene-motion";
import { NAVIGATION_PAGE } from "../../../../fixtures/rendering/pressure-navigation";
import { FakeNode, fakeNode } from "../../../../unit/rendering/scene/fakes";

it("bounds real fade publication and replay interruption across 10,000 mounted memberships", () => {
  const records = createViewportRectangleStore(10_000, () => 10);
  const indexed = createIndexedSceneStore(records);
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, indexed.store);
  scheduler.runAll(200);
  const startedAt = scheduler.time;
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
    scheduler.time = startedAt + 149;
    frame();
    expect(renderer.mountedCount).toBe(10_000);
    scheduler.time = startedAt + 150;
    for (let frames = 0; scheduler.pendingCount > 0; frames += 1) {
      expect(frames).toBeLessThan(200);
      frame();
    }
    expect(renderer.mountedCount).toBe(0);
    replay(false);
    expect(collectReplayFadeTargets(frame, "enter").size).toBe(10_000);
    expect(renderer.mountedCount).toBe(10_000);
    scheduler.time = startedAt + 299;
    frame();
    expect(content.nodes.every((node) => activeFades(node).length > 0)).toBe(true);
    const propertyWrites = properties.mock.calls.length;
    const interruptedWrites = styles.mock.calls.length;
    const interruptedStarts = fades.mock.calls.length;
    renderer.interruptMotionForPointerDown();
    expect(properties.mock.calls.length - propertyWrites).toBe(2);
    expect(styles.mock.calls).toHaveLength(interruptedWrites);
    expect(fades.mock.calls).toHaveLength(interruptedStarts);
    scheduler.time = startedAt + 300;
    for (let frames = 0; scheduler.pendingCount > 0; frames += 1) {
      expect(frames).toBeLessThan(100);
      frame();
    }
    expect(
      content.nodes.every((node) => activeFades(node).length === 0 && !node.style.visibility),
    ).toBe(true);
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

it("interrupts 600 geometry entries in one pass without cache recounts", () => {
  const harness = createMotionHarness(600, 0);
  const originalValues = Object.getOwnPropertyDescriptor(Map.prototype, "values")!.value as (
    this: Map<unknown, unknown>,
  ) => MapIterator<unknown>;
  let visits = 0;
  const values = vi.spyOn(Map.prototype, "values").mockImplementation(function (
    this: Map<unknown, unknown>,
  ) {
    const iterator = originalValues.call(this);
    const next = iterator.next.bind(iterator);
    iterator.next = () => {
      const result = next();
      if (
        !result.done &&
        typeof result.value === "object" &&
        result.value !== null &&
        "kind" in result.value &&
        "id" in result.value &&
        typeof result.value.id === "number"
      )
        visits += 1;
      return result;
    };
    return iterator;
  });
  try {
    harness.motion.refreshInstrumentation();
    expect(visits).toBe(0);
    harness.motion.interruptForPointerDown();
    expect(visits).toBe(600);
    expect(harness.content.clearElementPreview).toHaveBeenCalledTimes(600);
    harness.motion.refreshInstrumentation();
    harness.motion.release();
    expect(visits).toBe(600);
    expect(harness.motion.cacheMemoryUsage()).toBe(0);
  } finally {
    values.mockRestore();
    harness.motion.release();
  }
});

function collectReplayFadeTargets(
  frame: () => Array<Parameters<typeof fadeStyle.setElementFadeNode>>,
  direction: "enter" | "exit",
): Set<SVGElement> {
  const targets = new Set<SVGElement>();
  for (let batch = 0; targets.size < 10_000; batch += 1) {
    expect(batch).toBeLessThan(100);
    for (const call of frame()) {
      expect(call[1]).toBe(150);
      expect(call[3]).toBe(direction);
      targets.add(call[0]);
    }
  }
  return targets;
}
