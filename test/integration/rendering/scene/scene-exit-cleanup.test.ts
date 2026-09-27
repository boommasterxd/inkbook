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

function beginCleanup(harness: ReturnType<typeof setup>): void {
  const mounted = harness.renderer.mountedCount;
  harness.scheduler.runNext();
  // An initial full fade allowance can leave the first frame for scene publication only.
  if (harness.renderer.mountedCount === mounted) harness.scheduler.runNext();
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
    beginCleanup(harness);
    expect(harness.renderer.mountedCount).toBe(136);
    expect(harness.renderer.hasPendingSceneCommit).toBe(false);
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

  it.each([0, 199])("bounds mixed deletion cleanup when %s other exits have faded", (count) => {
    const records = rectangles(200);
    const harness = setup(records);
    harness.renderer.setElementFade(
      records.slice(0, count).map(({ id }) => id),
      220,
    );
    remove(harness, records, false);
    beginCleanup(harness);
    expect(harness.renderer.mountedCount).toBe(136);
    expect(harness.content.nodes.every((node) => node.style.opacity === "0")).toBe(true);
    expect(harness.renderer.hasPendingSceneCommit).toBe(false);
    harness.scheduler.runAll();
    expectEmptyScene(harness);
    harness.renderer.destroy();
  });

  it("publishes the new viewport before obsolete offscreen nodes finish cleanup", () => {
    const next = fakeRectangleRecord("new-visible", 200, 10, 1_000);
    const harness = setup([...rectangles(200), next]);
    expect(harness.renderer.mountedCount).toBe(200);
    harness.renderer.setViewport({ height: 500, left: 0, top: 1_000, width: 500 });
    harness.scheduler.runNext();
    expect(harness.renderer.mountedIds("content")).toEqual([next.id]);
    expect(harness.renderer.mountedCount).toBe(137);
    expect(harness.scheduler.pendingCount).toBe(1);
    const newNode = harness.content.nodes.find((node) =>
      node.attributes.get("d")?.includes("1000"),
    );
    expect(newNode).toBeDefined();
    harness.scheduler.runAll();
    expect(harness.content.nodes).toEqual([newNode]);
    harness.renderer.destroy();
  });
});

describe("deferred scene exit cleanup", () => {
  it("keeps a committed erase faded until its complete transition finishes", () => {
    const records = rectangles(1);
    const harness = setup(records);
    harness.renderer.setReducedMotion(false);
    const path = harness.content.nodes[0]!;
    remove(harness, records);
    harness.renderer.clearElementFade(records.map(({ id }) => id));
    expect(path.style.animation).toContain("inkbook-element-erase 220ms");
    expect(path.style.filter).toBe("blur(20px)");
    expect(harness.renderer.instrumentation().motionTombstones).toBe(0);
    harness.scheduler.runNext();
    expect(harness.renderer.mountedCount).toBe(1);
    expect(harness.renderer.hasPendingSceneCommit).toBe(false);
    harness.scheduler.time += 220;
    harness.scheduler.runAll();
    expectEmptyScene(harness);
    harness.renderer.destroy();
  });

  it("restores a selection deleted with blur when Undo arrives before the transition finishes", () => {
    const records = rectangles(2);
    const harness = setup(records);
    harness.renderer.setReducedMotion(false);
    const original = [...harness.content.nodes];
    const ids = records.map(({ id }) => id);
    harness.renderer.setElementFade(ids, 300);
    remove(harness, records, false);
    harness.renderer.clearElementFade(ids);
    harness.scheduler.runNext();
    expect(harness.content.nodes).toEqual(original);
    expect(original.every((node) => node.style.filter === "blur(20px)")).toBe(true);
    harness.scheduler.time += 150;
    restore(harness, records);
    expect(original.every((node) => node.style.filter === "")).toBe(true);
    harness.scheduler.time += 300;
    harness.scheduler.runAll();
    expect(harness.content.nodes).toEqual(original);
    expect(harness.renderer.mountedIds("content")).toEqual(ids);
    expect(harness.renderer.instrumentation().motionTombstones).toBe(0);
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
    beginCleanup(harness);
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
    beginCleanup(harness);
    expect(harness.scheduler.pendingCount).toBe(1);
    harness.renderer.destroy();
    expect(harness.scheduler.pendingCount).toBe(0);
    expect(harness.renderer.mountedCount).toBe(0);
    expect(fakeNode(harness.renderer.svg).parent).toBeUndefined();
    harness.scheduler.runAll();
  });

  it.each([false, true])("handles a partially removed multipart element with Undo=%s", (undo) => {
    const element = { ...arrow(), startNode: "circle" as const, endNode: "triangle" as const };
    const record = { ...fakeRectangleRecord(element.id, 63, 10), element };
    const records = [...rectangles(63), record];
    const harness = setup(records);
    const original = [...harness.content.nodes];
    expect(original).toHaveLength(65);
    remove(harness, records);
    beginCleanup(harness);
    expect(harness.content.nodes).toHaveLength(1);
    expect(harness.renderer.mountedCount).toBe(1);
    if (undo) restore(harness, records);
    harness.scheduler.runAll();
    expect(harness.content.nodes).toHaveLength(undo ? 65 : 0);
    if (undo) expect(harness.content.nodes.slice(-2)).toEqual(original.slice(-2));
    harness.renderer.destroy();
  });
});

describe("retained DOM order after rank changes", () => {
  it.each(["paint", "geometry"] as const)(
    "reorders when %s updates refresh record ranks first",
    (domain) => {
      const records = [fakeRectangleRecord("first", 0, 10), fakeRectangleRecord("second", 1, 30)];
      const harness = setup(records);
      const original = [...harness.content.nodes];
      for (const record of records) {
        harness.store.records.set(record.id, {
          ...record,
          rank: 1 - record.rank,
          geometryVersion: record.geometryVersion + (domain === "geometry" ? 1 : 0),
          paintVersion: record.paintVersion + (domain === "paint" ? 1 : 0),
        });
      }
      harness.renderer.applyDelta({
        affected: records.map(({ id }) => ({ id, domains: [domain, "order"] })),
      });
      harness.scheduler.runAll();
      expect(harness.content.nodes).toEqual([...original].reverse());
      expect(harness.renderer.mountedIds("content")).toEqual(records.map(({ id }) => id).reverse());
      harness.renderer.destroy();
    },
  );

  it("reorders an offscreen retained exit that returns after visible nodes changed order", () => {
    const first = fakeRectangleRecord("first", 0, 10);
    const middle = fakeRectangleRecord("middle", 1, 10, 1000);
    const last = fakeRectangleRecord("last", 2, 30);
    const harness = setup([first, middle, last]);
    harness.renderer.setViewport({ height: 2000, left: 0, top: 0, width: 500 });
    harness.scheduler.runAll();
    const original = [...harness.content.nodes];
    expect(original).toHaveLength(3);
    harness.renderer.setReducedMotion(false);
    harness.renderer.setElementFade([middle.id], 10_000);
    harness.renderer.setReducedMotion(true);
    harness.renderer.setViewport({ height: 500, left: 0, top: 0, width: 500 });
    harness.store.records.set(first.id, { ...first, rank: 2 });
    harness.store.records.set(last.id, { ...last, rank: 0 });
    harness.renderer.applyDelta({
      affected: [
        ...[first, last].map(({ id }) => ({ id, domains: ["order" as const] })),
        { id: middle.id, domains: ["visibility"] },
      ],
    });
    harness.scheduler.runNext();
    expect(harness.content.nodes).toEqual([original[1], original[2], original[0]]);

    harness.renderer.setViewport({ height: 2000, left: 0, top: 0, width: 500 });
    harness.scheduler.runAll();
    expect(harness.renderer.mountedIds("content")).toEqual([last.id, middle.id, first.id]);
    expect(harness.content.nodes).toEqual([original[2], original[1], original[0]]);
    harness.renderer.clearElementFade([middle.id]);
    harness.renderer.destroy();
  });
});
