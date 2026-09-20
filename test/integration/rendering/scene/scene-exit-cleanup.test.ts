import { describe, expect, it, vi } from "vitest";
import { createSceneFixture } from "../../../fixtures/rendering/scene";
import type { SceneElementRecord } from "../../../../src/rendering/scene/types";
import { arrow } from "../../../unit/domain/schema/fixtures";
import { FakeSceneStore, fakeNode, fakeRectangleRecord } from "../../../unit/rendering/scene/fakes";

function setup(records: SceneElementRecord[]) {
  const store = new FakeSceneStore();
  for (const record of records) store.records.set(record.id, record);
  const { renderer, scheduler } = createSceneFixture(
    {
      activeBufferLines: 3,
      background: { type: "none" },
      innerWidth: 2000,
      lockedBufferLines: 1,
      margin: 24.3,
    },
    store,
    { height: 500, left: 0, top: 0, width: 500 },
  );
  renderer.setReducedMotion(true);
  scheduler.runAll();
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  return { content, renderer, scheduler, store };
}

function remove(
  harness: ReturnType<typeof setup>,
  records: readonly SceneElementRecord[],
  faded = true,
) {
  const ids = records.map(({ id }) => id);
  if (faded) harness.renderer.setElementFade(ids, 220);
  for (const id of ids) harness.store.records.delete(id);
  harness.renderer.applyDelta({
    affected: records.map(({ id, element }) => ({
      after: null,
      before: element,
      domains: ["visibility"],
      id,
    })),
  });
}

function restore(harness: ReturnType<typeof setup>, records: readonly SceneElementRecord[]) {
  for (const record of records) harness.store.records.set(record.id, record);
  harness.renderer.applyDelta({
    affected: records.map(({ id, element }) => ({
      after: element,
      before: null,
      domains: ["visibility"],
      id,
    })),
  });
}

function rectangles(count: number): SceneElementRecord[] {
  return Array.from({ length: count }, (_, rank) => fakeRectangleRecord(`r-${rank}`, rank, 10));
}

function expectEmptyScene(harness: ReturnType<typeof setup>): void {
  expect(harness.content.nodes).toHaveLength(0);
  expect(harness.renderer.mountedCount).toBe(0);
  expect(harness.renderer.hasPendingSceneCommit).toBe(false);
}

describe("sliced scene exit cleanup", () => {
  it("restores still-mounted faded nodes after Undo and safely cleans a subsequent Redo", () => {
    const records = rectangles(200);
    const harness = setup(records);
    const original = [...harness.content.nodes];
    remove(harness, records);
    harness.scheduler.runNext();
    expect(harness.renderer.mountedCount).toBe(136);
    expect(harness.renderer.hasPendingSceneCommit).toBe(true);
    const retained = [...harness.content.nodes];
    expect(retained.every((node) => node.style.opacity === "0")).toBe(true);

    restore(harness, records);
    harness.scheduler.runAll();
    expect(harness.renderer.mountedIds("content")).toEqual(records.map(({ id }) => id));
    expect(harness.content.nodes).toHaveLength(200);
    for (const node of retained) {
      expect(harness.content.nodes).toContain(node);
      expect(node.style.opacity).toBe("");
      expect(node.style.filter).toBe("");
    }
    expect(harness.content.nodes.map((node) => node.attributes.get("d"))).toEqual(
      original.map((node) => node.attributes.get("d")),
    );
    remove(harness, records);
    harness.scheduler.runAll();
    expectEmptyScene(harness);
    harness.renderer.destroy();
  });

  it.each([0, 199])("keeps unfaded deletion atomic when %s other exits have faded", (count) => {
    const records = rectangles(200);
    const harness = setup(records);
    harness.renderer.setElementFade(
      records.slice(0, count).map(({ id }) => id),
      220,
    );
    remove(harness, records, false);
    harness.scheduler.runNext();
    expectEmptyScene(harness);
    harness.renderer.destroy();
  });

  it("yields at the frame deadline after making progress", () => {
    const records = rectangles(10);
    const harness = setup(records);
    remove(harness, records);
    const removals = harness.content.nodes.map((node) => {
      const originalRemove = node.remove.bind(node);
      return vi.spyOn(node, "remove").mockImplementation(() => {
        originalRemove();
        harness.scheduler.time += 9;
      });
    });
    harness.scheduler.runNext();
    expect(removals.reduce((count, spy) => count + spy.mock.calls.length, 0)).toBe(1);
    expect(harness.renderer.mountedCount).toBe(9);
    harness.scheduler.runAll();
    expect(harness.renderer.mountedCount).toBe(0);
    for (const removal of removals) removal.mockRestore();
    harness.renderer.destroy();
  });
});

describe("interrupted scene exit cleanup", () => {
  it("restarts interrupted cleanup even when a layout invalidation retains visibility", () => {
    const records = rectangles(200);
    const harness = setup(records);
    remove(harness, records);
    harness.scheduler.runNext();
    harness.renderer.invalidateLayout();
    harness.scheduler.runAll();
    expect(harness.content.nodes).toHaveLength(0);
    expect(harness.renderer.mountedCount).toBe(0);
    harness.renderer.destroy();
  });

  it("cancels pending cleanup and releases the scene on destruction", () => {
    const records = rectangles(200);
    const harness = setup(records);
    remove(harness, records);
    harness.scheduler.runNext();
    expect(harness.scheduler.pendingCount).toBe(1);
    harness.renderer.destroy();
    expect(harness.scheduler.pendingCount).toBe(0);
    expect(harness.renderer.mountedCount).toBe(0);
    expect(fakeNode(harness.renderer.svg).parent).toBeUndefined();
    harness.scheduler.runAll();
  });

  it.each([false, true])("handles a partially removed multipart element with Undo=%s", (undo) => {
    const element = { ...arrow(), startNode: "circle" as const, endNode: "triangle" as const };
    const record = { ...fakeRectangleRecord(element.id, 0, 10), element };
    const records = [
      record,
      ...rectangles(63).map((entry) => ({ ...entry, rank: entry.rank + 1 })),
    ];
    const harness = setup(records);
    const original = [...harness.content.nodes];
    expect(original).toHaveLength(65);
    remove(harness, records);
    harness.scheduler.runNext();
    expect(harness.content.nodes).toHaveLength(1);
    expect(harness.renderer.mountedCount).toBe(1);
    if (undo) restore(harness, records);
    harness.scheduler.runAll();
    expect(harness.content.nodes).toHaveLength(undo ? 65 : 0);
    if (undo) expect(harness.content.nodes.slice(0, 2)).toEqual(original.slice(0, 2));
    harness.renderer.destroy();
  });
});
