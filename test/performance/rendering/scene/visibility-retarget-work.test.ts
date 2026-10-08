import { expect, it, vi } from "vitest";
import { SpatialQueryCursor } from "../../../../src/domain/spatial/query-cursor";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { MountSlice } from "../../../../src/rendering/scene/mount-slice";
import { SceneEntrantPriority } from "../../../../src/rendering/scene/scene-entrant-priority";
import { SceneVisibilityState } from "../../../../src/rendering/scene/visibility-state";
import { commitVisibleBands } from "../../../../src/rendering/scene/visibility-order";
import { visibilityPageBounds } from "../../../../src/rendering/scene/scene-resource-policy";
import {
  createViewportRectangleStore,
  observeIndexedSceneQueries,
} from "../../../fixtures/rendering/scene";
import { FakeSceneStore, fakeRectangleRecord } from "../../../unit/rendering/scene/fakes";
import { createInteractionFixture } from "./interaction-refresh-profile-fixture";

const BOUNDS = { minX: 0, maxX: 100, minY: 0, maxY: 100 };

it.each(["minX", "maxX", "minY", "maxY"] as const)(
  "reuses the exact current reserve boundary on %s and queries beyond it",
  (edge) => {
    const store = createViewportRectangleStore(1, () => 45);
    const instrumentation = createInstrumentation();
    const state = new SceneVisibilityState(store, instrumentation);
    const original = state.query(BOUNDS).visibility.content.ids;
    const query = vi.spyOn(store, "query");
    const get = vi.spyOn(store, "get");
    const increasing = edge === "minX" || edge === "minY";
    const current = { ...BOUNDS, [edge]: increasing ? 20 : 80 };
    const retained = { minX: 20, maxX: 80, minY: 20, maxY: 80 };
    retained[edge] = current[edge] + (increasing ? 20 : -20);
    expect(state.query(current, retained).visibility.content.ids).toBe(original);
    expect(instrumentation.visibilityHysteresisHits).toBe(1);
    expect(query).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    current[edge] += increasing ? 1 : -1;
    retained[edge] += increasing ? 1 : -1;
    state.query(current, retained);
    expect(query).toHaveBeenCalledOnce();
    expect(instrumentation.visibilityHysteresisHits).toBe(1);
    state.release();
    expect(state.queryMemoryUsage()).toBe(0);
  },
);

it("shrinks a 10,000-member zoom envelope through bounded indexed work and cancels stale shrink work", () => {
  const fixture = createInteractionFixture();
  const port = new ElementSceneStore(fixture.store);
  const instrumentation = createInstrumentation();
  const state = new SceneVisibilityState(port, instrumentation);
  const { query, work } = observeIndexedSceneQueries(fixture.store);
  const viewport = { height: 100, left: 0, top: 0, width: 100 };
  const broad = visibilityPageBounds(viewport, { x: 0, zoom: 0.1 });
  const original = state.query(broad.envelope, broad.retained).visibility;
  expect(original.content.count).toBe(10_000);
  const baselineMemory = state.queryMemoryUsage();
  const initialVisits = work.indexedVisits;
  const initialQueries = query.mock.calls.length;
  const smallZoom = visibilityPageBounds(viewport, { x: 0, zoom: 0.101 });
  expect(state.query(smallZoom.envelope, smallZoom.retained).visibility.content.ids).toBe(
    original.content.ids,
  );
  expect(instrumentation.visibilityHysteresisHits).toBe(1);
  expect(work.indexedVisits).toBe(initialVisits);
  expect(query).toHaveBeenCalledTimes(initialQueries);
  fixture.store.resetInstrumentation();
  const tight = visibilityPageBounds(viewport, { x: 0, zoom: 1 });
  const cancel = vi.spyOn(SpatialQueryCursor.prototype, "cancel");
  const suspended = state.query(
    tight.envelope,
    tight.retained,
    true,
    8,
    () => work.indexedVisits - initialVisits,
  );
  expect(suspended.pending).toBe(true);
  expect(suspended.visibility.content.count).toBe(10_000);
  expect(work.indexedVisits - initialVisits).toBeLessThanOrEqual(8);
  expect(state.queryMemoryUsage()).toBeGreaterThan(baselineMemory);
  expect(state.queryMemoryUsage()).toBeLessThanOrEqual(baselineMemory + 10_000 * 64 + 512);
  const interruptedVisits = work.indexedVisits;
  cancel.mockClear();
  expect(state.query(broad.envelope, broad.retained).visibility.content.ids).toBe(
    original.content.ids,
  );
  expect(work.indexedVisits).toBe(interruptedVisits);
  expect(cancel).toHaveBeenCalledOnce();
  expect(state.queryMemoryUsage()).toBe(baselineMemory);
  const complete = state.query(tight.envelope, tight.retained);
  expect(complete.pending).toBeUndefined();
  expect(complete.visibility.content.count).toBe(663);
  expect(complete.delta?.entered).toEqual([]);
  expect(complete.delta?.exited).toHaveLength(9_337);
  // At most two interrupted fringes plus four restarted shrink fringes.
  expect(query.mock.calls.length - initialQueries).toBeLessThanOrEqual(6);
  expect(work.indexedVisits - initialVisits).toBeLessThanOrEqual(4 * 10_000 + 512);
  expect(fixture.store.instrumentation).toMatchObject({ fullStoreScans: 0, bandScans: 0 });
  expect(state.queryMemoryUsage()).toBe(baselineMemory);
  state.release();
  port.release();
  expect(state.queryMemoryUsage()).toBe(0);
  cancel.mockRestore();
});

function observeBounds(store: FakeSceneStore, onRead: () => void): void {
  for (const [id, record] of store.records) {
    const bounds = new Proxy(record.bounds, {
      get(target, key) {
        onRead();
        const value: unknown = Reflect.get(target, key);
        return value;
      },
    });
    store.records.set(id, { ...record, bounds });
  }
}

it("acquires 10,000 distinct records across retargets and reclassifies previously excluded records", () => {
  const store = createViewportRectangleStore(10_000, () => 160);
  const state = new SceneVisibilityState(store, createInstrumentation());
  let clock = 0;
  const get = vi.spyOn(store, "get").mockImplementation((id) => {
    clock += 1;
    return store.records.get(id);
  });
  for (let target = 0; target < 10; target += 1) {
    clock = 0;
    const bounds = { ...BOUNDS, maxY: 100 + target * 10 };
    const result = state.query(bounds, bounds, false, 1_000, () => clock);
    expect(result.pending).toBe(true);
    expect(result.visibility.content.count).toBe(0);
    expect(state.contains("entry-0")).toBe(false);
    expect(get).toHaveBeenCalledTimes((target + 1) * 1_000);
    expect(state.queryMemoryUsage()).toBeLessThanOrEqual(10_000 * 32);
  }
  const latest = { ...BOUNDS, maxY: 200 };
  expect(state.query(latest, latest, false).visibility.content.count).toBe(10_000);
  expect(new Set(get.mock.calls.map(([id]) => id)).size).toBe(10_000);
  const removed = store.records.get("entry-0")!;
  store.records.delete(removed.id);
  state.releaseId(removed.id);
  state.invalidateForChanges(removed.bounds, null);
  expect(state.query(latest, latest, false).visibility.content.count).toBe(9_999);
  expect(state.contains(removed.id)).toBe(false);
  state.release();
  expect(state.queryMemoryUsage()).toBe(0);
  clock = 0;
  expect(state.query(latest, latest, false, 1_000, () => clock).pending).toBe(true);
  expect(state.queryMemoryUsage()).toBeGreaterThan(0);
  state.release();
  expect(state.queryMemoryUsage()).toBe(0);
});

it("rechecks retained exclusions against the latest bounds after partial classification", () => {
  const store = createViewportRectangleStore(3, (rank) => (rank === 0 ? 160 : 20));
  vi.spyOn(store, "query").mockImplementation((_bounds, sink) => {
    for (const id of store.records.keys()) sink.add(id);
  });
  let clock = 0;
  const get = vi.spyOn(store, "get");
  observeBounds(store, () => {
    clock += 1;
  });
  const state = new SceneVisibilityState(store, createInstrumentation());
  expect(state.query(BOUNDS, BOUNDS, false, 4, () => clock).pending).toBe(true);
  expect(get).toHaveBeenCalledOnce();
  expect(state.contains("entry-0")).toBe(false);
  const next = { ...BOUNDS, maxY: 200 };
  expect(state.query(next, next, false).visibility.content.count).toBe(3);
  expect(get).toHaveBeenCalledTimes(3);
  expect(state.contains("entry-0")).toBe(true);
  state.release();
  expect(state.queryMemoryUsage()).toBe(0);
});

it("classifies fresh acquisition in the same admitted record step without a second complete pass", () => {
  const store = createViewportRectangleStore(10_000, () => 20);
  vi.spyOn(store, "query").mockImplementation((_bounds, sink) => {
    for (const id of store.records.keys()) sink.add(id);
  });
  let boundsReads = 0;
  observeBounds(store, () => {
    boundsReads += 1;
  });
  const get = vi.spyOn(store, "get");
  const state = new SceneVisibilityState(store, createInstrumentation());
  let clock = 0;
  const result = state.query(BOUNDS, BOUNDS, false, 10_001, () => clock++);
  expect(result.pending).toBeUndefined();
  expect(result.visibility.content.count).toBe(10_000);
  expect(get).toHaveBeenCalledTimes(10_000);
  expect(boundsReads).toBe(40_000);
  expect(clock).toBe(10_001);
  state.release();
  expect(state.queryMemoryUsage()).toBe(0);
});

it("preserves partial heap acquisition across safe retargets without revisiting stored bounds", () => {
  const store = createViewportRectangleStore(10_000, (rank) => 20 + rank / 1_000);
  let boundsReads = 0;
  observeBounds(store, () => {
    boundsReads += 1;
  });
  let clock = 0;
  const get = vi.spyOn(store, "get").mockImplementation((id) => {
    clock += 1;
    return store.records.get(id);
  });
  const base = { viewport: BOUNDS, direction: { x: 0, y: 1 } };
  const priority = new SceneEntrantPriority(
    store.records.keys(),
    store,
    new Set(),
    createInstrumentation(),
    base,
  );
  for (let target = 0; target < 10; target += 1) {
    const acquired = get.mock.calls.length;
    const reads = boundsReads;
    priority.retarget([], [], { ...base, viewport: { ...BOUNDS, minY: target / 100 } });
    expect(boundsReads).toBe(reads);
    clock = 0;
    priority.build(new MountSlice(1_000, () => clock));
    expect(get.mock.calls.length - acquired).toBe(1_000);
    expect(priority.count).toBe((target + 1) * 1_000);
    // Partial acquisition owns seen, candidate and exact-viewport membership slots.
    expect(priority.memoryUsage()).toBeLessThanOrEqual(10_000 * 184);
  }
  expect(priority.build(new MountSlice(Infinity, () => 0))).toBeUndefined();
  expect(new Set(get.mock.calls.map(([id]) => id)).size).toBe(10_000);
  priority.retarget([], [], { ...base, direction: { x: 0, y: -1 } });
  const before = get.mock.calls.length;
  expect(priority.build(new MountSlice(Infinity, () => 0))).toBeUndefined();
  expect(get).toHaveBeenCalledTimes(before);
  const ids = [...store.records.keys()];
  const last = ids[ids.length - 1]!;
  expect(priority.take()).toBe(last);
  priority.release(last);
  priority.retarget([last], ["entry-0"], base);
  expect(priority.build(new MountSlice(Infinity, () => 0))).toBeUndefined();
  expect(get).toHaveBeenCalledTimes(before + 1);
  expect(priority.count).toBe(9_999);
  expect([...priority.upcoming(priority.count)]).not.toContain("entry-0");
});

it("merges a two-member edge delta once and commits immutable band references without another copy", () => {
  const store = new FakeSceneStore();
  const ids = Array.from({ length: 10_001 }, (_, rank) => `row-${rank}`);
  ids.forEach((id, rank) => {
    const record = fakeRectangleRecord(id, rank, 20, rank);
    store.records.set(id, { ...record, bounds: { minX: 20, maxX: 30, minY: rank, maxY: rank } });
  });
  const state = new SceneVisibilityState(store, createInstrumentation());
  const original = { ...BOUNDS, maxY: 9_999 };
  const first = state.query(original, original, false).visibility;
  let reads = 0;
  let writes = 0;
  for (let index = 0; index < first.content.count; index += 1) {
    let value = first.content.ids[index];
    Object.defineProperty(first.content.ids, index, {
      configurable: true,
      get: () => {
        reads += 1;
        return value;
      },
      set: (next: string | undefined) => {
        writes += 1;
        value = next;
      },
    });
  }
  const get = vi.spyOn(store, "get");
  const next = { ...original, minY: 1, maxY: 10_000 };
  const changed = state.query(next, next);
  expect(changed.delta).toEqual({ entered: [ids[ids.length - 1]], exited: [ids[0]] });
  expect(reads).toBe(10_000);
  expect(writes).toBe(0);
  expect(get.mock.calls.length).toBeLessThanOrEqual(4);
  const committed = { content: first.content.ids, highlight: first.highlight.ids };
  const counts = { content: first.content.count, highlight: first.highlight.count };
  let commitReads = 0;
  const source = new Proxy(changed.visibility.content.ids, {
    get(target, key) {
      if (typeof key === "string" && /^\d+$/.test(key)) commitReads += 1;
      const value: unknown = Reflect.get(target, key);
      return value;
    },
  });
  const visibility = {
    ...changed.visibility,
    content: { ...changed.visibility.content, ids: source },
  };
  commitVisibleBands(committed, counts, visibility);
  expect(commitReads).toBe(0);
  expect(committed.content).toBe(source);
  expect(committed.content).toEqual(ids.slice(1));
  expect(first.content.ids[0]).toBe(ids[0]);
  const previousCommit = committed.content;
  const back = state.query(original, original);
  expect(previousCommit).toEqual(ids.slice(1));
  expect(back.visibility.content.ids).toEqual(ids.slice(0, -1));
  state.release();
  expect(previousCommit).toEqual(ids.slice(1));
});
