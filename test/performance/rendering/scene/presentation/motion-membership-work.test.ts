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
import { FakeNode, fakeNode, fakeRectangleRecord } from "../../../../unit/rendering/scene/fakes";
import * as elementPath from "../../../../../src/domain/geometry/element-path";
import type { SceneContentRenderer } from "../../../../../src/rendering/scene/content-renderer";
import { MAX_STROKE_POINTS, type BoxShapeElementV1 } from "../../../../../src/domain/schema/public";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { observePointReads } from "../../../../fixtures/rendering/point-reads";

function crossfadeCapacity(limit: "paths" | "bytes") {
  if (limit === "paths")
    return {
      element: fakeRectangleRecord("paint", 0, 0).element as BoxShapeElementV1,
      paths: undefined,
      capacity: 256,
      pointReads: () => 0,
    };
  const stroke = indexedStroke(1);
  stroke.style = { ...stroke.style, pressureEnabled: false, smoothing: 0.5 };
  stroke.points = Array.from({ length: MAX_STROKE_POINTS }, (_, index) => [
    index * 10.123,
    index % 4 < 2 ? 100.456 : 200.789,
    0.5,
  ]).flat();
  const paths = elementPath.buildElementPathParts(stroke);
  expect(paths).toHaveLength(1);
  const capacity = Math.floor((4 * 1024 * 1024) / (paths[0]!.d.length * 2));
  expect(capacity).toBeGreaterThan(1);
  expect(capacity).toBeLessThan(256);
  let pointReads = 0;
  stroke.points = observePointReads(stroke.points, () => {
    pointReads += 1;
  });
  return { element: stroke, paths, capacity, pointReads: () => pointReads };
}

it.each(["paths", "bytes"] as const)(
  "bounds retained style composites, preparation and cleanup at the %s limit",
  (limit) => {
    const { motion, content, dom } = createMotionHarness(0, 0);
    const fixture = crossfadeCapacity(limit);
    let element = fixture.element;
    const capacity = fixture.capacity;
    const canonical = vi.spyOn(
      content as Pick<SceneContentRenderer, "readCanonicalStrokePath">,
      "readCanonicalStrokePath",
    );
    if (fixture.paths !== undefined) canonical.mockReturnValue(fixture.paths);
    const builds = vi.spyOn(elementPath, "buildElementPathParts");
    const allocations = vi.spyOn(dom.ownerDocument, "createElementNS");
    const style = dom.motionGroup.style;
    const writes = vi.spyOn(Object.getPrototypeOf(style) as typeof style, "setProperty");
    const paint = () => {
      const before = element;
      element =
        before.kind === "stroke"
          ? { ...before, style: { ...before.style, opacity: before.style.opacity === 1 ? 0.8 : 1 } }
          : {
              ...before,
              style: {
                ...before.style,
                outlineOpacity: before.style.outlineOpacity === 1 ? 0.8 : 1,
              },
            };
      motion.applyDelta([{ id: element.id, before, after: element, domains: ["paint"] }]);
    };
    try {
      paint();
      motion.write(0, Infinity, () => 0);
      const initialBuilds = builds.mock.calls.length;
      const initialAllocations = allocations.mock.calls.length;
      for (let pending = 0; pending < 20; pending += 1) paint();
      expect(builds.mock.calls).toHaveLength(initialBuilds);
      expect(allocations.mock.calls).toHaveLength(initialAllocations);
      motion.write(0, Infinity, () => 0);
      for (let layer = 1; layer < capacity; layer += 1) {
        motion.write(layer * 20, Infinity, () => 0);
        const buildStart = builds.mock.calls.length;
        const nodeStart = allocations.mock.calls.length;
        const writeStart = writes.mock.calls.length;
        paint();
        expect(builds.mock.calls.length - buildStart).toBe(limit === "paths" ? 1 : 0);
        expect(allocations.mock.calls.length - nodeStart).toBe(1);
        expect(writes.mock.calls.length - writeStart).toBe(2);
        const frameWrites = writes.mock.calls.length;
        motion.write(layer * 20, Infinity, () => 0);
        expect(writes.mock.calls.length - frameWrites).toBeLessThanOrEqual(512);
        expect(dom.motionGroup.nodes).toHaveLength(layer + 1);
        expect(motion.cacheMemoryUsage()).toBeLessThanOrEqual(4 * 1024 * 1024);
      }
      motion.write(capacity * 20, Infinity, () => 0);
      const retained = [...dom.motionGroup.nodes];
      const beforeBuilds = builds.mock.calls.length;
      const beforeNodes = allocations.mock.calls.length;
      const beforeWrites = writes.mock.calls.length;
      paint();
      expect(builds.mock.calls).toHaveLength(beforeBuilds);
      expect(allocations.mock.calls).toHaveLength(beforeNodes);
      expect(writes.mock.calls.length - beforeWrites).toBeLessThanOrEqual(2);
      expect(dom.motionGroup.nodes).toHaveLength(0);
      expect(retained.every((node) => node.parentNode === null)).toBe(true);
      expect(motion.cacheMemoryUsage()).toBe(0);
      expect(motion.pending).toBe(false);
      expect(fixture.pointReads()).toBe(0);
      paint();
      expect(dom.motionGroup.nodes).toHaveLength(1);
      motion.release();
      expect(dom.motionGroup.nodes).toHaveLength(0);
      expect(motion.cacheMemoryUsage()).toBe(0);
    } finally {
      builds.mockRestore();
      allocations.mockRestore();
      writes.mockRestore();
      canonical.mockRestore();
      motion.release();
    }
  },
);

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

it.each(["queued", "running"] as const)(
  "settles 10,000 %s eraser exits within the existing frame publication and work budgets",
  (state) => {
    const records = createViewportRectangleStore(10_000, () => 10);
    const indexed = createIndexedSceneStore(records);
    const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, indexed.store);
    scheduler.runAll(200);
    const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
    const ids = [...records.records.keys()];
    const retainedBefore = renderer.memoryUsage().pathCacheBytes;
    const writeFade = fadeStyle.setElementFadeNode;
    const fades = vi.spyOn(fadeStyle, "setElementFadeNode");
    const animations = vi.spyOn(FakeNode.prototype, "animate");
    try {
      renderer.setElementFade(ids, 150);
      expect(animations).toHaveBeenCalledTimes(128);
      if (state === "running") {
        for (let frame = 0; scheduler.pendingCount > 0; frame += 1) {
          expect(frame).toBeLessThan(100);
          scheduler.runNext();
        }
        expect(animations).toHaveBeenCalledTimes(10_000);
      }
      const before = fades.mock.calls.length;
      const started = animations.mock.calls.length;
      scheduler.time += 25;
      renderer.setReducedMotion(true);
      expect(fades).toHaveBeenCalledTimes(before);
      fades.mockImplementation((...args) => {
        scheduler.time += 2;
        return writeFade(...args);
      });
      for (let frame = 0; scheduler.pendingCount > 0; frame += 1) {
        expect(frame).toBeLessThan(2_600);
        const writes = fades.mock.calls.length;
        scheduler.runNext();
        // Simulated target work consumes the actual shared eight-millisecond slice.
        expect(fades.mock.calls.length - writes).toBeLessThanOrEqual(4);
        expect(scheduler.pendingCount).toBeLessThanOrEqual(1);
      }
      expect(fades.mock.calls.length - before).toBe(10_000);
      expect(animations).toHaveBeenCalledTimes(started);
      expect(content.nodes.every((node) => activeFades(node).length === 0)).toBe(true);
      expect(content.nodes.every((node) => node.style.opacity === "0")).toBe(true);
      // The estimate owns a 64-byte fade record and its 48-byte finish-index entry per exit.
      expect(renderer.memoryUsage().pathCacheBytes - retainedBefore).toBe(10_000 * (64 + 48));
      renderer.setReducedMotion(false);
      renderer.clearElementFade(ids);
      scheduler.runAll();
      expect(content.nodes.every((node) => !node.style.opacity)).toBe(true);
      expect(renderer.memoryUsage().pathCacheBytes).toBe(retainedBefore);
      expect(indexed.fallback).not.toHaveBeenCalled();
    } finally {
      fades.mockRestore();
      animations.mockRestore();
      renderer.destroy();
    }
    expect(scheduler.pendingCount).toBe(0);
    expect(renderer.memoryUsage()).toEqual({ pathCacheBytes: 0, motionCacheBytes: 0 });
  },
);

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
