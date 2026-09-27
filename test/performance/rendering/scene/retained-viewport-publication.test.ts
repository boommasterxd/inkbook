import { expect, it, vi } from "vitest";

import { createSceneFixture, createSceneRecord } from "../../../fixtures/rendering/scene";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import { arrow } from "../../../unit/domain/schema/fixtures";
import {
  FakeNode,
  FakeSceneStore,
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

  const originalInsert = Object.getOwnPropertyDescriptor(FakeNode.prototype, "insertBefore")!
    .value as (this: FakeNode, node: FakeNode, reference: FakeNode | null) => FakeNode;
  const insert = vi.spyOn(content, "insertBefore");
  let writes = 0;
  insert.mockImplementation(function (this: FakeNode, node, reference) {
    writes += node.fragment ? node.nodes.length : 1;
    return originalInsert.call(this, node, reference);
  });
  try {
    renderer.resetInstrumentation();
    renderer.setViewport(target);
    let frames = 0;
    while (scheduler.pendingCount > 0) {
      writes = 0;
      scheduler.runNext();
      expect(writes).toBeLessThanOrEqual(64);
      expect(++frames).toBeLessThanOrEqual(20);
    }
    expect(renderer.instrumentation().domReorders).toBeGreaterThan(64);
    expect(renderer.mountedIds("content")).toEqual([...store.records.keys()]);
    expect(content.nodes).toHaveLength(257);
  } finally {
    insert.mockRestore();
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});
