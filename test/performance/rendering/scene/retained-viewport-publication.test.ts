import { expect, it, vi } from "vitest";

import { createSceneFixture, createSceneRecord } from "../../../fixtures/rendering/scene";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { arrow } from "../../../unit/domain/schema/fixtures";
import {
  FakeNode,
  FakeSceneStore,
  type FakeScheduler,
  fakeNode,
  fakeRectangleRecord,
} from "../../../unit/rendering/scene/fakes";

it("bounds retained reorder writes when a partially detached arrow returns", () => {
  const store = new FakeSceneStore();
  const target = { height: 100, left: 0, top: 100, width: 400 };
  const element = { ...arrow(500), start: { x: 200, y: 150 }, end: { x: 300, y: 150 } };
  for (let rank = 0; rank < 256; rank += 1) {
    const record =
      rank === 200
        ? createSceneRecord(element, rank)
        : fakeRectangleRecord(`retained-${rank}`, rank, 20, 150);
    store.records.set(record.id, record);
  }
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, target);
  scheduler.runAll(20);
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  expect(content.nodes).toHaveLength(257);
  const arrowTail = content.nodes[201]!;
  const remove = vi.spyOn(arrowTail, "remove");
  const originalRemove = Object.getOwnPropertyDescriptor(FakeNode.prototype, "remove")!.value as (
    this: FakeNode,
  ) => void;
  remove.mockImplementation(() => {
    originalRemove.call(arrowTail);
    scheduler.time += 8;
  });
  renderer.setViewport({ ...target, top: 1_000 });
  scheduler.runNext();
  expect(remove).toHaveBeenCalledOnce();
  expect(arrowTail.parent).toBeUndefined();
  remove.mockRestore();

  try {
    renderer.resetInstrumentation();
    const writes = collectFrameWrites(content, scheduler, () => renderer.setViewport(target), 20);
    expect(writes.every((count) => count <= 64)).toBe(true);
    expect(renderer.instrumentation().domReorders).toBeGreaterThan(64);
    expect(renderer.mountedIds("content")).toEqual([...store.records.keys()]);
    expect(content.nodes).toHaveLength(257);
  } finally {
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

it("bounds a single new stroke while page growth reveals a dense 10,000-entry document", () => {
  const store = new FakeSceneStore();
  const viewport = { height: 100, left: 0, top: 0, width: 100 };
  for (let rank = 0; rank < 10_000; rank += 1) {
    const y = rank < 2_000 ? 10 : rank < 4_000 ? 1_000 : 10_000;
    const record = fakeRectangleRecord(`entry-${rank}`, rank, 20 + rank / 100_000, y);
    store.records.set(record.id, record);
  }
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, viewport);
  scheduler.runAll(100);
  const element = {
    ...indexedStroke(10_001),
    pivot: { x: 25, y: 1_010 },
    points: [20, 1_010, 0.5, 30, 1_010, 0.5],
  };
  const newRecord = createSceneRecord(element, 10_000);
  store.records.set(newRecord.id, newRecord);
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  try {
    const writes = collectFrameWrites(
      content,
      scheduler,
      () => {
        renderer.setPage(NAVIGATION_PAGE, 2_000);
        renderer.setViewport({ ...viewport, top: 1_000 });
        renderer.applyDelta({
          affected: [
            {
              before: null,
              after: element,
              domains: ["geometry", "paint", "order", "visibility"],
              id: element.id,
            },
          ],
        });
      },
      100,
    );
    expect(writes.some((count) => count > 0)).toBe(true);
    expect(writes.every((count) => count <= 64)).toBe(true);
    const expected = [...store.records.values()].filter(
      ({ rank }) => (rank >= 2_000 && rank < 4_000) || rank === 10_000,
    );
    expect(renderer.mountedIds("content")).toEqual(expected.map(({ id }) => id));
    expect(
      content.nodes.map((node) => node.nodes[0]?.attributes.get("d") ?? node.attributes.get("d")),
    ).toEqual(expected.map(({ element: ink }) => buildElementPathParts(ink)[0]!.d));
  } finally {
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

function collectFrameWrites(
  content: FakeNode,
  scheduler: FakeScheduler,
  action: () => void,
  frameLimit: number,
): number[] {
  const original = Object.getOwnPropertyDescriptor(FakeNode.prototype, "insertBefore")!.value as (
    this: FakeNode,
    node: FakeNode,
    reference: FakeNode | null,
  ) => FakeNode;
  const insert = vi.spyOn(content, "insertBefore");
  let roots = 0;
  insert.mockImplementation(function (this: FakeNode, node, reference) {
    roots += node.fragment ? node.nodes.length : 1;
    return original.call(this, node, reference);
  });
  const writes: number[] = [];
  try {
    action();
    while (scheduler.pendingCount > 0) {
      roots = 0;
      scheduler.runNext();
      writes.push(roots);
      expect(writes.length).toBeLessThanOrEqual(frameLimit);
    }
  } finally {
    insert.mockRestore();
  }
  return writes;
}
