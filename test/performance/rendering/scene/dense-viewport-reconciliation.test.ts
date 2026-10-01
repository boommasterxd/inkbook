import type { SvgSceneRenderer } from "../../../../src/rendering/scene";
import { ProgressivePreviewPath } from "../../../../src/rendering/scene/progressive-preview-path";
import { mergeVisibleBand } from "../../../../src/rendering/scene/visibility-order";
import {
  FakeNode,
  FakeSceneStore,
  type FakeScheduler,
  fakeNode,
  fakeRectangleRecord,
} from "../../../unit/rendering/scene/fakes";
import {
  createSceneFixture,
  createSceneRecord,
  createViewportRectangleStore,
} from "../../../fixtures/rendering/scene";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { arrow } from "../../../unit/domain/schema/fixtures";
import { selectionTraceNodes } from "../../../fixtures/rendering/selection-traces";
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

it("bounds rank comparisons when a mostly retained viewport gains ten elements", () => {
  const previous = Array.from({ length: 800 }, (_, rank) => `retained-${rank}`);
  const entrants = Array.from({ length: 10 }, (_, rank) => `entrant-${rank}`);
  const ranks = new Map(previous.map((id, rank) => [id, rank * 2]));
  entrants.forEach((id, rank) => ranks.set(id, rank * 160 + 1));
  const output: (string | undefined)[] = [];
  let comparisons = 0;
  const count = mergeVisibleBand(
    previous,
    previous.length,
    entrants,
    output,
    () => true,
    (left, right) => {
      comparisons += 1;
      return ranks.get(left)! - ranks.get(right)!;
    },
  );
  expect(count).toBe(810);
  expect(output.slice(0, count)).toEqual(
    [...previous, ...entrants].sort((left, right) => ranks.get(left)! - ranks.get(right)!),
  );
  expect(comparisons).toBeLessThanOrEqual(850);
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
  requireSceneCommit = true,
): void {
  const camera = fakeNode(renderer.svg).nodes[1]!;
  const groups = new Set([camera.nodes[3], camera.nodes[4], camera.nodes[8]]);
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
    let frames = 0;
    while (scheduler.pendingCount > 0) {
      expect(++frames).toBeLessThanOrEqual(400);
      writes = 0;
      scheduler.runNext();
      expect(writes).toBeLessThanOrEqual(64);
      if (first) {
        expect(writes).toBeGreaterThan(0);
        if (requireSceneCommit) expect(renderer.hasPendingSceneCommit).toBe(true);
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

it("bounds combined ink and selection publication when 6,081 selected entries return", () => {
  const store = new FakeSceneStore();
  const selected = new Set<string>();
  for (let rank = 0; rank < 10_000; rank += 1) {
    const record = fakeRectangleRecord(
      `entry-${rank}`,
      rank,
      20 + rank / 100_000,
      rank < 6_081 ? 10 : 10_000,
    );
    store.records.set(record.id, record);
    if (rank < 6_081) selected.add(record.id);
  }
  const viewport = { height: 100, left: 0, top: 0, width: 100 };
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, viewport);
  scheduler.runAll(200);
  renderer.setSelectedElements(selected);
  scheduler.runAll(200);
  expect(selectionTraceNodes(fakeNode(renderer.svg))).toHaveLength(selected.size);
  renderer.setViewport({ ...viewport, top: 1_000 });
  scheduler.runAll(200);
  expect(selectionTraceNodes(fakeNode(renderer.svg))).toHaveLength(0);

  renderer.resetInstrumentation();
  renderer.setViewport(viewport);
  verifyPublicationSlices(
    renderer,
    scheduler,
    () => renderer.setViewport({ ...viewport, top: 1_000 }),
    false,
  );
  expect(selectionTraceNodes(fakeNode(renderer.svg))).toHaveLength(0);
  expect(renderer.mountedCount).toBe(0);

  renderer.resetInstrumentation();
  renderer.setViewport(viewport);
  verifyPublicationSlices(renderer, scheduler, undefined, false);
  expect(renderer.mountedIds("content")).toEqual([...selected]);
  expect(selectionTraceNodes(fakeNode(renderer.svg))).toHaveLength(selected.size);
  expect(renderer.instrumentation()).toMatchObject({
    domEntrants: selected.size,
    domReorders: 0,
    selectionTraceNodesCreated: selected.size,
  });
  renderer.destroy();
  expect(scheduler.pendingCount).toBe(0);
});

it("serves both selected centers and new ink after a page and viewport growth", () => {
  const store = new FakeSceneStore();
  const selected = new Set<string>();
  for (let rank = 0; rank < 256; rank += 1) {
    const record = fakeRectangleRecord(`grown-${rank}`, rank, 20 + rank / 100_000, 1_000);
    store.records.set(record.id, record);
    selected.add(record.id);
  }
  const viewport = { height: 100, left: 0, top: 0, width: 100 };
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, viewport);
  scheduler.runAll();
  renderer.setSelectedElements(selected);
  renderer.setPage(NAVIGATION_PAGE, 2_000);
  renderer.setViewport({ ...viewport, top: 1_000 });
  scheduler.runNext();
  expect(renderer.instrumentation().domEntrants).toBeGreaterThan(0);
  scheduler.runNext();
  expect(renderer.instrumentation().selectionTraceNodesCreated).toBeGreaterThan(0);
  expect(renderer.instrumentation().domEntrants).toBeLessThan(selected.size);
  scheduler.runAll(20);
  expect(renderer.mountedIds("content")).toEqual([...selected]);
  expect(selectionTraceNodes(fakeNode(renderer.svg))).toHaveLength(selected.size);
  renderer.destroy();
  expect(scheduler.pendingCount).toBe(0);
});

it("bounds live writes when a multi-root arrow joins selected single-root ink", () => {
  const store = new FakeSceneStore();
  const target = { height: 100, left: 0, top: 100, width: 400 };
  const twoRoot = { ...arrow(500), start: { x: 200, y: 150 }, end: { x: 300, y: 150 } };
  store.records.set(twoRoot.id, createSceneRecord(twoRoot));
  const selected = new Set([twoRoot.id]);
  for (let rank = 1; rank <= 63; rank += 1) {
    const record = fakeRectangleRecord(`single-${rank}`, rank, 20 + rank / 100_000, 150);
    store.records.set(record.id, record);
    selected.add(record.id);
  }
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, {
    ...target,
    top: 1_000,
  });
  scheduler.runAll();
  renderer.setSelectedElements(selected);
  renderer.setViewport(target);
  verifyPublicationSlices(renderer, scheduler, undefined, false);
  expect(renderer.mountedIds("content")).toEqual([...store.records.keys()]);
  expect(fakeNode(renderer.svg).nodes[1]!.nodes[4]!.nodes).toHaveLength(65);
  expect(selectionTraceNodes(fakeNode(renderer.svg))).toHaveLength(selected.size);
  renderer.destroy();
  expect(scheduler.pendingCount).toBe(0);
});

it("reinstates 315 ordered entries without moving retained DOM nodes in a 10,000-entry document", () => {
  const store = new FakeSceneStore();
  const ids = Array.from({ length: 10_000 }, (_, rank) => `entry-${rank}`);
  const removed = new Set(Array.from({ length: 315 }, (_, index) => ids[index * 13]!));
  for (const [rank, id] of ids.entries()) {
    store.records.set(id, fakeRectangleRecord(id, rank, 20, rank < 4_220 ? 10 : 10_000));
  }
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, {
    height: 100,
    left: 0,
    top: 0,
    width: 100,
  });
  scheduler.runAll(200);
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  const originalNodes = [...content.nodes];
  const retainedNodes = new Set(originalNodes.filter((_, rank) => !removed.has(ids[rank]!)));
  expect(originalNodes).toHaveLength(4_220);

  for (const id of removed) store.records.delete(id);
  const afterRemoval = ids.filter((id) => !removed.has(id));
  for (const [rank, id] of afterRemoval.entries()) {
    const record = store.records.get(id)!;
    store.records.set(id, { ...record, rank });
  }
  renderer.applyDelta({
    affected: ids.map((id) => ({
      id,
      domains: removed.has(id) ? (["order", "visibility"] as const) : (["order"] as const),
    })),
  });
  scheduler.runAll(200);
  expect(content.nodes).toHaveLength(4_220 - removed.size);

  for (const [rank, id] of ids.entries()) {
    const record =
      store.records.get(id) ?? fakeRectangleRecord(id, rank, 20, rank < 4_220 ? 10 : 10_000);
    store.records.set(id, { ...record, rank });
  }
  const originalInsert = Object.getOwnPropertyDescriptor(FakeNode.prototype, "insertBefore")!
    .value as (this: FakeNode, node: FakeNode, reference: FakeNode | null) => FakeNode;
  const insert = vi.spyOn(FakeNode.prototype, "insertBefore");
  let retainedAppends = 0;
  let fragmentAppends = 0;
  let publishedNodes = 0;
  insert.mockImplementation(function (this: FakeNode, node, reference) {
    if (this.fragment) {
      fragmentAppends += 1;
      if (retainedNodes.has(node)) retainedAppends += 1;
    }
    if (this === content && node.fragment) publishedNodes += node.nodes.length;
    return originalInsert.call(this, node, reference);
  });
  try {
    renderer.resetInstrumentation();
    renderer.applyDelta({
      affected: ids.map((id) => ({
        id,
        domains: removed.has(id)
          ? (["geometry", "order", "visibility"] as const)
          : (["order"] as const),
      })),
    });
    scheduler.runAll(200);
    expect(fragmentAppends).toBe(removed.size);
    expect(retainedAppends).toBe(0);
    expect(publishedNodes).toBe(removed.size);
    expect(renderer.instrumentation().domReorders).toBe(0);
    expect(renderer.instrumentation().domEntrants).toBe(removed.size);
    expect(content.nodes).toHaveLength(4_220);
    for (let rank = 0; rank < 4_220; rank += 1) {
      if (removed.has(ids[rank]!)) expect(retainedNodes.has(content.nodes[rank]!)).toBe(false);
      else expect(content.nodes[rank]).toBe(originalNodes[rank]);
    }
  } finally {
    insert.mockRestore();
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

it("does not reappend returning retained nodes during unfinished viewport exit cleanup", () => {
  const store = createViewportRectangleStore(10_000, (rank) =>
    rank < 4_200 ? 10 : rank < 8_400 ? 1_000 : 10_000,
  );
  const viewport = { height: 100, left: 0, top: 0, width: 100 };
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, viewport);
  scheduler.runAll(200);
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  const originalNodes = [...content.nodes];
  const originalSet = new Set(originalNodes);
  expect(originalNodes).toHaveLength(4_200);

  renderer.setViewport({ ...viewport, top: 1_000 });
  let frames = 0;
  while (renderer.instrumentation().domEntrants < 8_400 && scheduler.pendingCount > 0) {
    scheduler.runNext();
    expect(++frames).toBeLessThan(200);
  }
  expect(renderer.instrumentation().domEntrants).toBe(8_400);
  const retained = new Set(content.nodes.filter((node) => originalSet.has(node)));
  expect(retained.size).toBeGreaterThan(4_000);
  expect(retained.size).toBeLessThan(4_200);

  const originalInsert = Object.getOwnPropertyDescriptor(FakeNode.prototype, "insertBefore")!
    .value as (this: FakeNode, node: FakeNode, reference: FakeNode | null) => FakeNode;
  const insert = vi.spyOn(FakeNode.prototype, "insertBefore");
  let retainedAppends = 0;
  let siblingScans = 0;
  let siblingVisits = 0;
  let siblingVisitBudget = 0;
  const childNodes = vi.spyOn(FakeNode.prototype, "childNodes", "get");
  childNodes.mockImplementation(function (this: FakeNode) {
    if (this !== content) return this.nodes;
    siblingScans += 1;
    siblingVisitBudget += this.nodes.length;
    if (siblingScans === 1) scheduler.time += 8;
    return new Proxy(this.nodes, {
      get(target, key) {
        if (typeof key === "string" && /^\d+$/.test(key)) siblingVisits += 1;
        const value: unknown = Reflect.get(target, key);
        return value;
      },
    });
  });
  insert.mockImplementation(function (this: FakeNode, node, reference) {
    if (this.fragment && retained.has(node)) retainedAppends += 1;
    return originalInsert.call(this, node, reference);
  });
  try {
    renderer.setViewport(viewport);
    scheduler.runAll(200);
    expect(retainedAppends).toBe(0);
    expect(siblingScans).toBe(0);
    expect(siblingVisits).toBe(0);
    expect(siblingVisitBudget).toBe(0);
    expect(content.nodes).toHaveLength(4_200);
    for (let rank = 0; rank < 4_200; rank += 1) {
      if (retained.has(originalNodes[rank]!)) expect(content.nodes[rank]).toBe(originalNodes[rank]);
    }
  } finally {
    childNodes.mockRestore();
    insert.mockRestore();
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

it("publishes new visible nodes while selected mounted traces remain dirty", () => {
  const store = new FakeSceneStore();
  const selected = new Set<string>();
  for (let index = 0; index < 300; index++) {
    const old = fakeRectangleRecord(`old-${index}`, index, 10 + index / 100_000);
    const next = fakeRectangleRecord(`next-${index}`, index, 10 + index / 100_000, 1_000);
    store.records.set(old.id, old);
    store.records.set(next.id, next);
    selected.add(old.id);
  }
  const { renderer, scheduler } = createSceneFixture(
    NAVIGATION_PAGE,
    store,
    { height: 100, left: 0, top: 0, width: 100 },
    { frameBudgetMs: 8 },
  );
  scheduler.runAll();
  const camera = fakeNode(renderer.svg).nodes[1]!;
  const content = camera.nodes[4]!;
  const insert = vi.spyOn(content, "insertBefore");
  const write = vi.spyOn(FakeNode.prototype, "setAttribute");
  let traceWrites = 0;
  write.mockImplementation(function (this: FakeNode, name, value) {
    if (name === "d" && this.attributes.get("class") === "inkbook-selection-center-trace") {
      traceWrites += 1;
      scheduler.time += 1;
    }
    this.attributes.set(name, value);
  });
  try {
    renderer.setSelectedElements(selected);
    renderer.setViewport({ height: 100, left: 0, top: 1_000, width: 100 });
    scheduler.runNext();
    expect(traceWrites).toBeGreaterThan(0);
    expect(traceWrites).toBeLessThan(300);
    expect(insert).not.toHaveBeenCalled();
    scheduler.runNext();
    expect(insert).toHaveBeenCalled();
    expect(renderer.instrumentation().domEntrants).toBeGreaterThan(300);
    expect(renderer.instrumentation().domEntrants).toBeLessThanOrEqual(364);
    expect(traceWrites).toBeLessThanOrEqual(16);
    scheduler.runAll();
    expect(renderer.mountedIds("content")).toEqual(
      [...store.records.keys()].filter((id) => id.startsWith("next-")),
    );
  } finally {
    write.mockRestore();
    insert.mockRestore();
    renderer.destroy();
  }
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
  const originalStep = ProgressivePreviewPath.prototype.step;
  const starts: { deadline: number; time: number }[] = [];
  const steps = vi.spyOn(ProgressivePreviewPath.prototype, "step").mockImplementation(function (
    this: ProgressivePreviewPath,
    deadline,
    now,
  ) {
    starts.push({ deadline: deadline ?? Infinity, time: scheduler.time });
    scheduler.time += 0.25;
    return originalStep.call(this, deadline, now);
  });
  try {
    renderer.setViewport({ height: 100, left: 0, top: 980, width: 100 });
    scheduler.runNext();
    expect(steps.mock.calls.length).toBeGreaterThan(4);
    expect(starts.slice(1).every(({ deadline, time }) => time < deadline)).toBe(true);
    expect(scheduler.time).toBeGreaterThanOrEqual(starts[0]!.deadline);
    expect(renderer.mountedCount).toBeGreaterThan(0);
    expect(renderer.mountedCount).toBeLessThan(10);
    expect(scheduler.pendingCount).toBeGreaterThan(0);
    let frames = 1;
    while (scheduler.pendingCount > 0) {
      steps.mockClear();
      starts.length = 0;
      scheduler.time += 10;
      scheduler.runNext();
      expect(starts.slice(1).every(({ deadline, time }) => time < deadline)).toBe(true);
      expect(++frames).toBeLessThanOrEqual(4);
    }
    expect(renderer.mountedCount).toBe(10);
    expect(renderer.instrumentation().geometryBuilds).toBe(10);
  } finally {
    steps.mockRestore();
    renderer.destroy();
  }
});
