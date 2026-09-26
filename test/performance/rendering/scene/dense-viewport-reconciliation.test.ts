import type { SvgSceneRenderer } from "../../../../src/rendering/scene";
import { ProgressivePreviewPath } from "../../../../src/rendering/scene/progressive-preview-path";
import {
  FakeNode,
  FakeSceneStore,
  type FakeScheduler,
  fakeNode,
  fakeRectangleRecord,
} from "../../../unit/rendering/scene/fakes";
import { createSceneFixture, createSceneRecord } from "../../../fixtures/rendering/scene";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { describe, expect, it, vi } from "vitest";

import {
  DENSE_VIEWPORT_PROFILES,
  createDenseViewportFixture,
  createDenseViewportHarness,
} from "../../../integration/rendering/scene/dense-viewport-fixture";

describe("dense viewport reconciliation performance", () => {
  for (const profile of DENSE_VIEWPORT_PROFILES) {
    it(`bounds ${profile.name} reconciliation frame work`, () => {
      run(profile.viewport);
    });
  }
});

function run(viewport: readonly [number, number]): void {
  const fixture = createDenseViewportFixture();
  const { renderer, scheduler, store } = createDenseViewportHarness({ fixture, viewport });
  verifyPublicationSlices(renderer, scheduler);
  const instrumentation = renderer.instrumentation();
  expect(instrumentation).toMatchObject({
    geometryBuilds: fixture.records.length,
    domEntrants: fixture.records.length,
    spatialQueries: 1,
    pathCacheEntries: 0,
  });
  expect(store.queryCount).toBe(1);
  expect(scheduler.pendingCount).toBe(0);
  expect(renderer.mountedIds("highlight")).toEqual(fixture.highlightIds);
  expect(renderer.mountedIds("content")).toEqual(fixture.contentIds);
  renderer.destroy();
  expect(renderer.mountedCount).toBe(0);
  expect(scheduler.pendingCount).toBe(0);
}

function verifyPublicationSlices(
  renderer: SvgSceneRenderer,
  scheduler: FakeScheduler,
  afterFirst?: () => void,
): void {
  const camera = fakeNode(renderer.svg).nodes[1]!;
  const groups = new Set([camera.nodes[3], camera.nodes[4]]);
  const original = Object.getOwnPropertyDescriptor(FakeNode.prototype, "insertBefore")!.value as (
    this: FakeNode,
    node: FakeNode,
    reference: FakeNode | null,
  ) => FakeNode;
  const insert = vi.spyOn(FakeNode.prototype, "insertBefore");
  let writes = 0;
  insert.mockImplementation(function (this: FakeNode, node, reference) {
    if (groups.has(this)) writes += node.fragment ? node.nodes.length : 1;
    return original.call(this, node, reference);
  });
  try {
    let first = true;
    while (scheduler.pendingCount > 0) {
      writes = 0;
      scheduler.runNext();
      expect(writes).toBeLessThanOrEqual(64);
      if (first) {
        expect(writes).toBeGreaterThan(0);
        expect(renderer.hasPendingSceneCommit).toBe(true);
        first = false;
        afterFirst?.();
      }
    }
  } finally {
    insert.mockRestore();
  }
}

it("publishes a 10,000-entry viewport without an atomic DOM burst", () => {
  const store = new FakeSceneStore();
  for (let index = 0; index < 10_000; index++) {
    const record = fakeRectangleRecord(`entry-${index}`, index, 10 + index / 100_000);
    store.records.set(record.id, record);
  }
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store);
  verifyPublicationSlices(renderer, scheduler, () => renderer.clearPreviewTransforms());
  expect(renderer.mountedCount).toBe(10_000);
  expect(renderer.instrumentation().geometryBuilds).toBe(10_000);
  expect(renderer.mountedIds("content")).toEqual([...store.records.keys()]);
  renderer.destroy();
  expect(scheduler.pendingCount).toBe(0);
});

it("shares bounded preparation work across cold strokes instead of yielding four steps per stroke", () => {
  const store = new FakeSceneStore();
  for (let index = 0; index < 10; index++) {
    const element = {
      ...indexedStroke(index),
      pivot: { x: 20, y: 1_000 + index },
      points: Array.from({ length: 250 }, (_, sample) => [
        20 + sample * 0.3,
        1_000 + index + Math.sin(sample * 0.3) * 2,
        0.2 + (0.6 * (sample % 20)) / 20,
      ]).flat(),
    };
    store.records.set(element.id, createSceneRecord(element, index));
  }
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, {
    height: 100,
    left: 0,
    top: 0,
    width: 100,
  });
  scheduler.runAll();
  const steps = vi.spyOn(ProgressivePreviewPath.prototype, "step");
  try {
    renderer.setViewport({ height: 100, left: 0, top: 980, width: 100 });
    scheduler.runNext();
    expect(steps.mock.calls.length).toBeGreaterThan(4);
    expect(steps.mock.calls.length).toBeLessThanOrEqual(64);
    expect(renderer.mountedCount).toBeGreaterThan(0);
    let frames = 1;
    while (scheduler.pendingCount > 0) {
      steps.mockClear();
      scheduler.runNext();
      expect(steps.mock.calls.length).toBeLessThanOrEqual(64);
      expect(++frames).toBeLessThanOrEqual(3);
    }
    expect(renderer.mountedCount).toBe(10);
    expect(scheduler.time).toBe(0);
  } finally {
    steps.mockRestore();
    renderer.destroy();
  }
});
