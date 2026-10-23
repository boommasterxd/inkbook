import { describe, expect, it, vi } from "vitest";
import { createSceneFixture, createSceneRecord } from "../../../../fixtures/rendering/scene";
import { activeFade, activeFades } from "../../../../fixtures/rendering/scene-fades";
import { buildElementPathParts } from "../../../../../src/domain/geometry/element-path";
import { createInstrumentation } from "../../../../../src/rendering/scene/instrumentation";
import {
  createMountedElement,
  type MountedSceneElement,
} from "../../../../../src/rendering/scene/content/mounted-element";
import { resetReconciliationBuffers } from "../../../../../src/rendering/scene/reconciliation/reconciliation-buffers";
import type { PendingReconciliation } from "../../../../../src/rendering/scene/reconciliation/reconciliation-state";
import { removeOrderedVisibilityExits } from "../../../../../src/rendering/scene/reconciliation/visibility-reconciliation-commit";
import type { SceneElementRecord } from "../../../../../src/rendering/scene/types";
import { arrow } from "../../../../unit/domain/schema/fixtures";
import {
  asDocument,
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  fakeNode,
  fakeRectangleRecord,
} from "../../../../unit/rendering/scene/fakes";

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

it("defers native removal when many repeated exits spend the preparation deadline", () => {
  const node = new FakeNode(new FakeDocument(), "path");
  const remove = vi.spyOn(node, "remove");
  const entry = {
    id: "single",
    band: "content",
    committedRank: 0,
    detachedPathCount: 0,
    paths: [{ node }],
  } as unknown as MountedSceneElement;
  const pending = {
    exitIds: Array<string>(20_000).fill(entry.id),
    exitIndex: 0,
    exitScanComplete: true,
    exitOrderPrepared: false,
  } as PendingReconciliation;
  const options = {
    mounted: new Map([[entry.id, entry]]),
  } as unknown as Parameters<typeof removeOrderedVisibilityExits>[1];
  let reads = 0;
  expect(
    removeOrderedVisibilityExits(pending, options, {
      deadline: 8,
      now: () => (reads++ === 0 ? 0 : 8),
      isExit: () => true,
    }),
  ).toBe(false);
  expect(pending.exitIds).toEqual([entry.id]);
  expect(pending.exitIndex).toBe(0);
  expect(remove).not.toHaveBeenCalled();
  remove.mockRestore();
});

describe("deduplicated scene cleanup", () => {
  it.each([false, true])(
    "preserves deduplicated exits and the partial head with pending entrants=%s",
    (preservePending) => {
      const document = asDocument(new FakeDocument());
      const instrumentation = createInstrumentation();
      const records = [...rectangles(2), createSceneRecord(arrow(500), 2)];
      const entries = records.map((record) =>
        createMountedElement(
          document,
          record,
          buildElementPathParts(record.element),
          instrumentation,
        ),
      );
      const partial = entries[2]!;
      partial.paths[1]!.node.remove();
      partial.detachedPathCount = 1;
      const removals = entries.flatMap((entry) =>
        entry.paths.map(({ node }) => vi.spyOn(node, "remove")),
      );
      const pending = {
        exitIds: ["consumed", partial.id, "r-1", "r-0", partial.id, "r-1", "r-0", "stale"],
        exitIndex: 1,
        exitScanComplete: true,
        exitOrderPrepared: false,
      } as PendingReconciliation;
      const removed = vi.fn<(id: string) => void>();
      const skipped = vi.fn();
      const releaseId = vi.fn();
      const options = {
        mounted: new Map(entries.map((entry) => [entry.id, entry])),
        store: new FakeSceneStore(),
        instrumentation,
        visibility: { releaseId },
        pathCache: { invalidate: vi.fn(), retain: vi.fn() },
      } as unknown as Parameters<typeof removeOrderedVisibilityExits>[1];
      const get = vi.spyOn(options.mounted, "get");
      resetReconciliationBuffers({
        preservePending,
        preserveExits: true,
        exitCursor: pending,
        entrants: new Map(),
        exitIds: pending.exitIds,
        publishedEntrantIds: [],
        newlyMountedIds: [],
        runs: [],
      });
      pending.exitIndex = 0;
      try {
        expect(
          removeOrderedVisibilityExits(pending, options, {
            deadline: 8,
            now: () => 0,
            isExit: () => true,
            onRemoved: removed,
            onSkipped: skipped,
          }),
        ).toBe(true);
        expect(pending.exitIds).toEqual([partial.id, "r-0", "r-1", "stale"]);
        expect(removed.mock.calls.map(([id]) => id)).toEqual([partial.id, "r-0", "r-1"]);
        expect(removals.map((spy) => spy.mock.calls.length)).toEqual([1, 1, 1, 0]);
        expect(skipped).toHaveBeenCalledExactlyOnceWith("stale");
        expect(releaseId).toHaveBeenCalledTimes(3);
        expect(options.mounted.size).toBe(0);
        expect(get.mock.calls.every(([id]) => id !== "consumed")).toBe(true);
        expect(get.mock.calls.length).toBeLessThanOrEqual(32);
      } finally {
        for (const spy of removals) spy.mockRestore();
      }
    },
  );
});

describe("sliced scene exit cleanup", () => {
  it("removes collected exits in committed rank order within the per-frame node cap", () => {
    const records = rectangles(200);
    const harness = setup(records);
    const removed: number[] = [];
    const removals = harness.content.nodes.map((node, rank) => {
      const original = node.remove.bind(node);
      return vi.spyOn(node, "remove").mockImplementation(() => {
        removed.push(rank);
        original();
      });
    });
    try {
      harness.renderer.setElementFade(
        records.map(({ id }) => id),
        0,
      );
      harness.scheduler.runAll();
      remove(harness, [...records].reverse(), false);
      let previous = 0;
      while (harness.scheduler.pendingCount > 0) {
        harness.scheduler.runNext();
        expect(removed.length - previous).toBeLessThanOrEqual(64);
        previous = removed.length;
      }
      expect(removed).toEqual(records.map(({ rank }) => rank));
      expectEmptyScene(harness);
    } finally {
      for (const removal of removals) removal.mockRestore();
      harness.renderer.destroy();
    }
  });
});

describe("mixed scene exit cleanup", () => {
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
    expect(harness.renderer.instrumentation().domExits).toBe(200 - harness.renderer.mountedCount);
    expect(harness.content.nodes.some((node) => node.style.opacity === "0")).toBe(true);
    expect(harness.renderer.hasPendingSceneCommit).toBe(false);
    harness.scheduler.runAll();
    expectEmptyScene(harness);
    harness.renderer.destroy();
  });

  it("publishes the new viewport before detaching obsolete roots in bounded cleanup", () => {
    const next = fakeRectangleRecord("new-visible", 200, 10, 1_000);
    const harness = setup([...rectangles(200), next]);
    expect(harness.renderer.mountedCount).toBe(200);
    harness.renderer.setViewport({ height: 500, left: 0, top: 1_000, width: 500 });
    harness.scheduler.runNext();
    expect(harness.renderer.mountedIds("content")).toContain(next.id);
    expect(harness.renderer.mountedCount).toBeGreaterThan(1);
    expect(harness.renderer.mountedCount).toBeLessThanOrEqual(201);
    expect(harness.scheduler.pendingCount).toBeGreaterThan(0);
    const newNode = harness.content.nodes.find((node) =>
      node.attributes.get("d")?.includes("1000"),
    );
    expect(newNode).toBeDefined();
    harness.scheduler.runAll();
    expect(harness.content.nodes).toEqual([newNode]);
    expect(harness.renderer.mountedIds("content")).toEqual([next.id]);
    expect(harness.renderer.instrumentation().domExits).toBe(200);
    expect(harness.renderer.instrumentation().detachedCacheEntries).toBe(200);
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
    expect(activeFade(path).options.duration).toBe(220);
    expect(path.style.filter).toBeUndefined();
    expect(harness.renderer.instrumentation().motionTombstones).toBe(0);
    harness.scheduler.runNext();
    expect(harness.renderer.mountedCount).toBe(1);
    expect(harness.renderer.hasPendingSceneCommit).toBe(false);
    harness.scheduler.time += 220;
    harness.scheduler.runAll();
    expectEmptyScene(harness);
    harness.renderer.destroy();
  });

  it("restores a selection deleted with opacity feedback when Undo arrives before the transition finishes", () => {
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
    expect(original.every((node) => activeFades(node).length === 1)).toBe(true);
    harness.scheduler.time += 150;
    restore(harness, records);
    expect(
      original.every((node) => activeFades(node).length === 0 && node.style.filter === undefined),
    ).toBe(true);
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

  it.each([false, true])(
    "retargets partially detached multipart culling with return=%s",
    (returns) => {
      const record = createSceneRecord(arrow(), 63);
      const next = fakeRectangleRecord("next", 64, 10, 10_000);
      const final = fakeRectangleRecord("final", 65, 10, 20_000);
      const records = [...rectangles(63), record];
      const harness = setup([...records, next, final]);
      const original = [...harness.content.nodes];
      expect(original).toHaveLength(65);
      harness.renderer.resetInstrumentation();
      harness.renderer.setViewport({ height: 500, left: 0, top: 10_000, width: 500 });
      harness.scheduler.runNext();
      expect(harness.content.nodes).toHaveLength(2);
      expect(harness.renderer.mountedCount).toBe(2);
      expect(harness.renderer.mountedIds("content")).toEqual([next.id]);
      expect(harness.renderer.instrumentation().detachedCacheEntries).toBe(63);
      if (returns) harness.renderer.setViewport({ height: 500, left: 0, top: 0, width: 500 });
      else harness.renderer.setViewport({ height: 500, left: 0, top: 20_000, width: 500 });
      harness.scheduler.runAll();
      if (returns) expect(harness.content.nodes).toEqual(original);
      else expect(original.every((node) => node.parent === undefined)).toBe(true);
      expect(harness.renderer.mountedCount).toBe(returns ? 64 : 1);
      expect(harness.renderer.mountedIds("content")).toEqual(
        returns ? records.map(({ id }) => id) : [final.id],
      );
      expect(harness.renderer.instrumentation().geometryBuilds).toBe(returns ? 1 : 2);
      harness.renderer.destroy();
      expect(harness.scheduler.pendingCount).toBe(0);
      expect(harness.renderer.memoryUsage().pathCacheBytes).toBe(0);
    },
  );
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
    expect(harness.content.nodes).toEqual([original[2], original[1], original[0]]);

    harness.renderer.setViewport({ height: 2000, left: 0, top: 0, width: 500 });
    harness.scheduler.runAll();
    expect(harness.renderer.mountedIds("content")).toEqual([last.id, middle.id, first.id]);
    expect(harness.content.nodes).toEqual([original[2], original[1], original[0]]);
    harness.renderer.clearElementFade([middle.id]);
    harness.renderer.destroy();
  });
});
