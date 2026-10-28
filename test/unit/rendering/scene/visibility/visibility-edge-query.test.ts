import { expect, it, vi } from "vitest";
import type { Bounds } from "../../../../../src/domain/geometry/primitives";
import { UniformSpatialIndex } from "../../../../../src/domain/spatial/uniform-spatial-index";
import { createInstrumentation } from "../../../../../src/rendering/scene/instrumentation";
import type { SceneStorePort } from "../../../../../src/rendering/scene/types";
import {
  VisibilityEdgeQuery,
  type EdgeProgress,
} from "../../../../../src/rendering/scene/visibility/visibility-edge-query";
import { SceneVisibilityState } from "../../../../../src/rendering/scene/visibility/visibility-state";
import { observeIndexedSceneQueries } from "../../../../fixtures/rendering/scene";
import { FakeSceneStore, fakeRectangleRecord } from "../fakes";

const BASE = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
const NEAR = { ...BASE, minY: 20, maxY: 120 };
const FAR = { ...BASE, minY: 40, maxY: 140 };
const SLICE = 8;

function indexedEdges(positions: readonly number[], count = positions.length) {
  const records = new FakeSceneStore();
  for (let rank = 0; rank < count; rank += 1) {
    const y = positions[rank % positions.length]!;
    const record = fakeRectangleRecord(`entry-${rank}`, rank, 20, y);
    records.records.set(record.id, record);
  }
  const index = new UniformSpatialIndex<string>();
  index.insertMany([...records.records.values()].map(({ id, bounds }) => ({ id, bounds })));
  const { work } = observeIndexedSceneQueries(index);
  const cancellations = vi.fn();
  const cursors: ReturnType<typeof index.beginQuery>[] = [];
  const costs = { indexed: 1, record: 0 };
  const get = vi.fn((id: string) => records.get(id));
  const fallback = vi.fn(() => {
    throw new Error("Edge queries must use the spatial cursor.");
  });
  const beginQuery = vi.fn((bounds: Bounds) => {
    const cursor = index.beginQuery(bounds);
    const cancel = cursor.cancel.bind(cursor);
    vi.spyOn(cursor, "cancel").mockImplementation(() => {
      cancellations();
      cancel();
    });
    cursors.push(cursor);
    return cursor;
  });
  const store: SceneStorePort = { get, query: fallback, beginQuery };
  const edge = new VisibilityEdgeQuery(store, createInstrumentation());
  const now = () => work.indexedVisits * costs.indexed + get.mock.calls.length * costs.record;
  const visible = (id: string) => {
    const bounds = records.get(id)?.bounds;
    return bounds !== undefined && bounds.minY <= BASE.maxY && bounds.maxY >= BASE.minY;
  };
  return {
    records,
    index,
    work,
    costs,
    get,
    fallback,
    beginQuery,
    cursors,
    cancellations,
    store,
    edge,
    now,
    visible,
  };
}

function expectChanges(
  result: EdgeProgress,
  entered: readonly string[],
  exited: readonly string[],
) {
  expect(result).not.toBe("pending");
  if (result === "pending") throw new Error("Expected a completed edge query.");
  expect(result.entered.map(({ id }) => id).sort()).toEqual([...entered].sort());
  expect([...result.exited].sort()).toEqual([...exited].sort());
}

function densePositions() {
  return Array.from({ length: 10_000 }, (_, rank) =>
    rank < 512 ? [0, 30, 110, 130][rank % 4]! : 10_000,
  );
}

it("finishes real indexed work across alternating targets and classifies only the latest bounds", () => {
  const fixture = indexedEdges(densePositions());
  const { edge, work, now, visible, get, fallback } = fixture;
  let result: EdgeProgress = "pending";
  let rounds = 0;
  while (result === "pending") {
    expect(++rounds).toBeLessThanOrEqual(80);
    const before = work.indexedVisits;
    const current = rounds % 2 === 0 ? NEAR : FAR;
    result = edge.collect(BASE, current, visible, now() + SLICE, now);
    expect(work.indexedVisits - before).toBeLessThanOrEqual(SLICE);
    // IDs, deduplication, records, prefix proofs and one membership delta stay per-candidate bounded.
    expect(edge.memoryUsage()).toBeLessThanOrEqual(512 * 160 + 2_048);
    if (result !== "pending") {
      const entered = Array.from(
        { length: current === FAR ? 256 : 128 },
        (_, index) =>
          `entry-${current === FAR ? 2 + Math.floor(index / 2) * 4 + (index % 2) : 2 + index * 4}`,
      );
      const exited = current === FAR ? Array.from({ length: 128 }, (_, i) => `entry-${i * 4}`) : [];
      expectChanges(result, entered, exited);
    }
  }
  // One shared cell contains all 512 candidates; unrelated offscreen records are never read.
  expect(work.indexedVisits).toBeLessThanOrEqual(512 + 32);
  expect(get).toHaveBeenCalledTimes(512);
  expect(new Set(get.mock.calls.map(([id]) => id)).size).toBe(512);
  expect(fallback).not.toHaveBeenCalled();
  edge.release();
  expect(edge.memoryUsage()).toBe(0);
});

it("coalesces adjacent unstarted fringes before visiting a shared dense boundary cell", () => {
  const { edge, now, visible, work, get, beginQuery } = indexedEdges([30], 512);
  const baseline = { ...BASE, minX: -80, maxX: 180 };
  const current = { ...baseline, minX: -30, maxX: 230 };
  let result: EdgeProgress = "pending";
  let rounds = 0;
  while (result === "pending") {
    expect(++rounds).toBeLessThanOrEqual(70);
    const before = work.indexedVisits;
    result = edge.collect(baseline, current, visible, now() + SLICE, now);
    expect(work.indexedVisits - before).toBeLessThanOrEqual(SLICE);
  }
  expectChanges(result, [], []);
  expect(beginQuery).toHaveBeenCalledOnce();
  expect(work.indexedVisits).toBeLessThanOrEqual(512 + 32);
  expect(get).toHaveBeenCalledTimes(512);
  edge.release();
  expect(edge.memoryUsage()).toBe(0);
});

it.each(["height", "width"] as const)(
  "keeps changed %s queries on exact fringes without acquiring neighboring cell records",
  (axis) => {
    const { edge, now, visible, get, beginQuery } = indexedEdges([0, 30, 110, 130], 128);
    const current = axis === "height" ? { ...BASE, maxY: 140 } : { ...BASE, maxX: 140 };
    const fringe = axis === "height" ? { ...current, minY: 100 } : { ...current, minX: 100 };
    const result = edge.collect(BASE, current, visible, Infinity, now);
    const entered =
      axis === "height"
        ? Array.from({ length: 64 }, (_, i) => `entry-${2 + Math.floor(i / 2) * 4 + (i % 2)}`)
        : [];
    expectChanges(result, entered, []);
    expect(beginQuery).toHaveBeenCalledExactlyOnceWith(fringe);
    expect(get).toHaveBeenCalledTimes(entered.length);
    edge.release();
    expect(edge.memoryUsage()).toBe(0);
  },
);

it("caches slow record acquisition while compatible targets change without restarting index work", () => {
  const { edge, costs, work, get, now, visible, beginQuery } = indexedEdges([0, 30, 110, 130], 128);
  costs.indexed = 0;
  costs.record = 1;
  expect(edge.collect(BASE, NEAR, visible, SLICE, now)).toBe("pending");
  expect(get).toHaveBeenCalledTimes(SLICE);
  const acquiredVisits = work.indexedVisits;
  const acquiredQueries = beginQuery.mock.calls.length;
  const acquiredMemory = edge.memoryUsage();
  for (const target of [FAR, NEAR, { ...NEAR, minY: 21, maxY: 121 }, FAR]) {
    expect(edge.collect(BASE, target, visible, now(), now)).toBe("pending");
    expect(edge.memoryUsage()).toBe(acquiredMemory);
    expect(get).toHaveBeenCalledTimes(SLICE);
  }
  let result: EdgeProgress = "pending";
  let rounds = 0;
  while (result === "pending") {
    expect(++rounds).toBeLessThanOrEqual(17);
    const before = get.mock.calls.length;
    result = edge.collect(BASE, rounds % 2 === 0 ? NEAR : FAR, visible, now() + SLICE, now);
    expect(get.mock.calls.length - before).toBeLessThanOrEqual(SLICE);
  }
  // Finish at the explicitly requested target using the already acquired records.
  result = edge.collect(BASE, FAR, visible, Infinity, now);
  expectChanges(
    result,
    Array.from({ length: 64 }, (_, i) => `entry-${2 + Math.floor(i / 2) * 4 + (i % 2)}`),
    Array.from({ length: 32 }, (_, i) => `entry-${i * 4}`),
  );
  expect(get).toHaveBeenCalledTimes(128);
  expect(new Set(get.mock.calls.map(([id]) => id)).size).toBe(128);
  expect(work.indexedVisits).toBe(acquiredVisits);
  expect(beginQuery).toHaveBeenCalledTimes(acquiredQueries);
  edge.release();
  expect(edge.pending).toBe(false);
  expect(edge.memoryUsage()).toBe(0);
});

it("extends pending cell coverage in both directions without retaining superseded target membership", () => {
  const { edge, work, now, records, get } = indexedEdges([-100, 20, 400, 600], 512);
  const baseline = { ...BASE, maxY: 512 };
  const forward = { ...baseline, minY: 256, maxY: 768 };
  const reverse = { ...baseline, minY: -256, maxY: 256 };
  const visible = (id: string) => {
    const y = records.get(id)!.bounds.minY;
    return y >= 0 && y <= 512;
  };
  expect(edge.collect(baseline, forward, visible, SLICE, now)).toBe("pending");
  const result = edge.collect(baseline, reverse, visible, Infinity, now);
  expectChanges(
    result,
    Array.from({ length: 128 }, (_, i) => `entry-${i * 4}`),
    Array.from({ length: 128 }, (_, i) => `entry-${2 + i * 4}`),
  );
  // Boundary cell visits may repeat, but every record is acquired only once.
  expect(work.indexedVisits).toBeLessThanOrEqual(512 * 3 + 128);
  expect(get).toHaveBeenCalledTimes(512);
  expect(new Set(get.mock.calls.map(([id]) => id)).size).toBe(512);
  edge.release();
  expect(edge.memoryUsage()).toBe(0);
});

it("drops stale indexed progress and restarts from current records", () => {
  const { edge, index, records, now, visible, cursors } = indexedEdges([0, 130], 128);
  expect(edge.collect(BASE, FAR, visible, SLICE, now)).toBe("pending");
  expect(edge.memoryUsage()).toBeGreaterThan(0);
  index.remove("entry-1");
  records.records.delete("entry-1");
  expect(edge.collect(BASE, FAR, visible, Infinity, now)).toBe("pending");
  expect(edge.pending).toBe(false);
  expect(edge.memoryUsage()).toBe(0);
  expect(cursors[0]!.memoryUsage()).toBe(0);
  expectChanges(
    edge.collect(BASE, FAR, visible, Infinity, now),
    Array.from({ length: 63 }, (_, i) => `entry-${3 + i * 2}`),
    Array.from({ length: 64 }, (_, i) => `entry-${i * 2}`),
  );
  edge.release();
  expect(edge.memoryUsage()).toBe(0);
});

it.each(["disjoint", "extent", "baseline", "release"] as const)(
  "cancels the owned cursor and drops cached resources after %s invalidation",
  (change) => {
    const { edge, now, visible, cursors, cancellations } = indexedEdges([20], 128);
    expect(edge.collect(BASE, FAR, visible, SLICE, now)).toBe("pending");
    expect(cursors[0]!.memoryUsage()).toBeGreaterThan(0);
    if (change === "release") edge.release();
    else {
      const previous = change === "baseline" ? NEAR : BASE;
      const target =
        change === "disjoint"
          ? { ...FAR, minY: 1_000, maxY: 1_100 }
          : change === "extent"
            ? { ...FAR, maxY: 141 }
            : FAR;
      expect(edge.collect(previous, target, visible, 0, now)).toBe("pending");
    }
    expect(cancellations).toHaveBeenCalledOnce();
    expect(cursors[0]!.memoryUsage()).toBe(0);
    edge.release();
    expect(edge.pending).toBe(false);
    expect(edge.memoryUsage()).toBe(0);
  },
);

it("keeps the non-indexed fallback exact when a sliced query is retargeted", () => {
  const records = new FakeSceneStore();
  for (const [rank, y] of [0, 30, 110, 130].entries()) {
    const record = fakeRectangleRecord(`entry-${rank}`, rank, 20, y);
    records.records.set(record.id, record);
  }
  const query = vi.spyOn(records, "query");
  let clock = 0;
  vi.spyOn(records, "get").mockImplementation((id) => {
    clock += 1;
    return records.records.get(id);
  });
  const edge = new VisibilityEdgeQuery(records, createInstrumentation());
  const visible = (id: string) => id === "entry-0" || id === "entry-1";
  expect(edge.collect(BASE, NEAR, visible, 1, () => clock)).toBe("pending");
  expectChanges(
    edge.collect(BASE, FAR, visible, Infinity, () => clock),
    ["entry-2", "entry-3"],
    ["entry-0"],
  );
  expect(query.mock.calls.map(([bounds]) => bounds)).toEqual([
    { ...BASE, maxY: 20 },
    { ...NEAR, minY: 100 },
    { ...BASE, maxY: 40 },
    { ...FAR, minY: 100 },
  ]);
  edge.release();
  expect(edge.memoryUsage()).toBe(0);
});

it("slices classification and defers marker adoption until an unexpired frame without repeating work", () => {
  const { store, get } = indexedEdges([0, 130], 16);
  const state = new SceneVisibilityState(store, createInstrumentation());
  const original = state.query(BASE).visibility;
  const before = Array.from({ length: 8 }, (_, i) => `entry-${i * 2}`);
  const after = Array.from({ length: 8 }, (_, i) => `entry-${i * 2 + 1}`);
  expect(original.content.ids).toEqual(before);
  get.mockClear();
  let clock = 0;
  const contains = state.contains.bind(state);
  const membership = vi.spyOn(state, "contains").mockImplementation((id) => {
    clock += 1;
    return contains(id);
  });
  try {
    for (const deadline of [SLICE, 2 * SLICE]) {
      const classified = membership.mock.calls.length;
      const pending = state.query(FAR, FAR, true, deadline, () => clock);
      expect(pending.pending).toBe(true);
      expect(pending.visibility.content.ids).toEqual(before);
      expect(membership.mock.calls.length - classified).toBe(SLICE);
      expect(contains("entry-0")).toBe(true);
      expect(contains("entry-1")).toBe(false);
    }
    const result = state.query(FAR, FAR, true, clock + 1, () => clock);
    expect(result.pending).not.toBe(true);
    expect(result.delta).toEqual({ entered: after, exited: before });
    expect(result.visibility.content.ids).toEqual(after);
    expect(contains("entry-0")).toBe(false);
    expect(contains("entry-1")).toBe(true);
    expect(membership).toHaveBeenCalledTimes(16);
    expect(get).toHaveBeenCalledTimes(16);
    expect(original.content.ids).toEqual(before);
  } finally {
    membership.mockRestore();
    state.release();
  }
  expect(state.queryMemoryUsage()).toBe(0);
});

it.each([1, 2])(
  "preserves stable classification progress with %i alternating candidates",
  (flippers) => {
    const positions = Array.from({ length: 256 }, (_, rank) =>
      rank === 1 || (flippers === 2 && rank === 255) ? 0 : 30,
    );
    const { edge, get, costs, work, beginQuery } = indexedEdges(positions);
    costs.indexed = 0;
    const membership = vi.fn((_id: string) => true);
    const now = () => membership.mock.calls.length;
    expect(edge.collect(BASE, NEAR, membership, SLICE, now)).toBe("pending");
    expect(membership).toHaveBeenCalledTimes(SLICE);
    const acquiredVisits = work.indexedVisits;
    const acquiredQueries = beginQuery.mock.calls.length;
    let result: EdgeProgress = "pending";
    let current = NEAR;
    let rounds = 0;
    while (result === "pending") {
      expect(++rounds).toBeLessThanOrEqual(35);
      current = rounds % 2 === 0 ? NEAR : FAR;
      const before = membership.mock.calls.length;
      result = edge.collect(BASE, current, membership, now() + SLICE, now);
      expect(membership.mock.calls.length - before).toBeLessThanOrEqual(SLICE);
    }
    const exited = flippers === 1 ? ["entry-1"] : ["entry-1", "entry-255"];
    expectChanges(result, [], current === FAR ? exited : []);
    // Opposite-end unstable candidates stay behind stable work instead of swapping forever.
    expect(membership.mock.calls.length).toBeLessThanOrEqual(256 + 2 * SLICE);
    expect(membership.mock.calls.filter(([id]) => id === "entry-0")).toHaveLength(1);
    expect(get).toHaveBeenCalledTimes(256);
    expect(work.indexedVisits).toBe(acquiredVisits);
    expect(beginQuery).toHaveBeenCalledTimes(acquiredQueries);
    edge.release();
    expect(edge.memoryUsage()).toBe(0);
  },
);

it("bounds region ownership across thousands of different compatible subpixel targets without admission", () => {
  const { edge, now, visible, work, get, beginQuery, cursors } = indexedEdges([30], 128);
  expect(edge.collect(BASE, NEAR, visible, SLICE, now)).toBe("pending");
  const visits = work.indexedVisits;
  const cursorBytes = cursors[0]!.memoryUsage();
  for (let index = 0; index < 2_000; index += 1) {
    const shiftX = (index % 2 === 0 ? 1 : -1) * (1 + index / 2_048);
    const shiftY = 1 + index / 2_048;
    const target = {
      minX: shiftX,
      maxX: 100 + shiftX,
      minY: shiftY,
      maxY: 100 + shiftY,
    };
    expect(edge.collect(BASE, target, visible, now(), now)).toBe("pending");
    // These targets touch only two 256-unit columns in one row, hence at most two regions.
    expect(edge.memoryUsage()).toBeLessThanOrEqual(cursorBytes + SLICE * 48 + 2 * 32);
  }
  expect(work.indexedVisits).toBe(visits);
  expect(get).not.toHaveBeenCalled();
  expect(beginQuery).toHaveBeenCalledOnce();
  edge.release();
  expect(cursors[0]!.memoryUsage()).toBe(0);
  expect(edge.memoryUsage()).toBe(0);
});
