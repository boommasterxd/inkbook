import { expect, it, vi } from "vitest";
import { SpatialQueryCursor } from "../../../../src/domain/spatial/query-cursor";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { MountSlice } from "../../../../src/rendering/scene/mount-slice";
import { SceneEntrantPriority } from "../../../../src/rendering/scene/scene-entrant-priority";
import { SceneVisibilityState } from "../../../../src/rendering/scene/visibility-state";
import { commitVisibleBands } from "../../../../src/rendering/scene/visibility-order";
import * as visibleOrder from "../../../../src/rendering/scene/visibility-order";
import { visibilityPageBounds } from "../../../../src/rendering/scene/scene-resource-policy";
import {
  createViewportRectangleStore,
  observeIndexedSceneQueries,
  createSceneFixture,
  sceneDeltaEntries,
} from "../../../fixtures/rendering/scene";
import { FakeSceneStore, fakeRectangleRecord } from "../../../unit/rendering/scene/fakes";
import { createInteractionFixture, INTERACTION_PAGE } from "./interaction-refresh-profile-fixture";

const BOUNDS = { minX: 0, maxX: 100, minY: 0, maxY: 100 };

it("reuses 10,000 retained ranks after geometry changes and preview release without a second order pass", () => {
  const store = createViewportRectangleStore(10_000, () => 20);
  const state = new SceneVisibilityState(store, createInstrumentation());
  const original = state.query(BOUNDS).visibility.content.ids;
  for (const record of store.records.values()) {
    store.records.set(record.id, {
      ...record,
      bounds: { ...record.bounds, minX: record.bounds.minX + 1 },
      geometryVersion: record.geometryVersion + 1,
    });
  }
  state.invalidateForChanges(BOUNDS, BOUNDS);
  const stable = vi.spyOn(visibleOrder, "retainedVisibleOrderStable");
  const sort = vi.spyOn(visibleOrder, "sortVisibleBand");
  const reads = vi.spyOn(Map.prototype, "get");
  try {
    const result = state.query(BOUNDS);
    const queryReads = reads.mock.calls.length;
    reads.mockClear();
    const released = state.resortCurrent();
    const releaseReads = reads.mock.calls.length;
    reads.mockRestore();
    expect(result.changed).toBe(false);
    expect(result.visibility.content.ids).toBe(original);
    expect(released.content.ids).toBe(original);
    // Each candidate needs its record and slot once; no retained visibility/rank scan remains.
    expect(queryReads).toBe(20_000);
    expect(releaseReads).toBe(20_000);
    expect(stable).not.toHaveBeenCalled();
    expect(sort).not.toHaveBeenCalled();
  } finally {
    reads.mockRestore();
    stable.mockRestore();
    sort.mockRestore();
    state.release();
  }
  expect(state.queryMemoryUsage()).toBe(0);
});

function createIndexedVisibilityState() {
  const fixture = createInteractionFixture();
  const port = new ElementSceneStore(fixture.store);
  const instrumentation = createInstrumentation();
  const state = new SceneVisibilityState(port, instrumentation);
  const { query, work } = observeIndexedSceneQueries(fixture.store);
  return { fixture, port, instrumentation, state, query, work };
}

it("clears candidate positions when a freed slot receives a different ID", () => {
  const store = createViewportRectangleStore(3, () => 10);
  const state = new SceneVisibilityState(store, createInstrumentation());
  expect(state.query(BOUNDS).visibility.content.count).toBe(3);
  const query = vi.spyOn(store, "query");
  const first = store.records.get("entry-0")!;
  const last = store.records.get("entry-2")!;
  store.records.delete(first.id);
  state.releaseId(first.id);
  state.invalidateForChanges(first.bounds, null, first.id);
  const replacement = fakeRectangleRecord("replacement", 0, 10);
  store.records.set(replacement.id, replacement);
  state.invalidateForChanges(null, replacement.bounds, replacement.id);
  store.records.delete(last.id);
  state.releaseId(last.id);
  state.invalidateForChanges(last.bounds, null, last.id);
  const result = state.query(BOUNDS);
  expect(result.visibility.content.ids.slice(0, result.visibility.content.count)).toEqual([
    "replacement",
    "entry-1",
  ]);
  expect(state.contains(first.id)).toBe(false);
  expect(state.contains(last.id)).toBe(false);
  expect(state.contains(replacement.id)).toBe(true);
  expect(query).not.toHaveBeenCalled();
  state.release();
  query.mockRestore();
  expect(state.queryMemoryUsage()).toBe(0);
});

it.each([false, true])(
  "patches a 10,000-stroke removal and restore without indexed visits or resort (coalesced: %s)",
  async (coalesced) => {
    const fixture = createInteractionFixture();
    const port = new ElementSceneStore(fixture.store);
    const { renderer, scheduler } = createSceneFixture(INTERACTION_PAGE, port, {
      height: 100,
      left: 0,
      top: 0,
      width: 100,
    });
    scheduler.runAll();
    const previous = renderer.mountedIds("content");
    expect(previous.length).toBeGreaterThan(100);
    const id = previous[0]!;
    const { query, work } = observeIndexedSceneQueries(fixture.store);
    const sort = vi.spyOn(visibleOrder, "sortVisibleBand");
    const unsubscribe = fixture.store.subscribe((delta) =>
      renderer.applyDelta({
        affected: sceneDeltaEntries(delta),
      }),
    );
    try {
      renderer.resetInstrumentation();
      const removed = fixture.store.removeWithHistory([id]);
      if (removed === null) throw new Error("Expected deletion.");
      if (!coalesced) {
        scheduler.runAll();
        expect(renderer.mountedIds("content")).toEqual(previous.slice(1));
        expect(renderer.instrumentation()).toMatchObject({
          domExits: 1,
          domReorders: 0,
          contentAttributeWrites: 0,
        });
      }
      const prepared = await fixture.store.prepareElementMutation(
        removed.transition.reverse,
        { shouldYield: () => false, yieldControl: async () => undefined },
        removed.transition,
      );
      expect(prepared.status).toBe("prepared");
      fixture.store.commitPreparedElementMutation(prepared.token!);
      scheduler.runAll();
      expect(renderer.mountedIds("content")).toEqual(previous);
      expect(query).not.toHaveBeenCalled();
      expect(work.indexedVisits).toBe(0);
      expect(sort).not.toHaveBeenCalled();
      expect(renderer.instrumentation()).toMatchObject({
        spatialQueries: 0,
        domReorders: 0,
        geometryBuilds: 0,
      });
      expect(renderer.instrumentation().contentAttributeWrites).toBeLessThanOrEqual(10);
      expect(renderer.instrumentation().domEntrants).toBeLessThanOrEqual(1);
    } finally {
      sort.mockRestore();
      query.mockRestore();
      unsubscribe();
      renderer.destroy();
      port.release();
    }
    expect(renderer.memoryUsage()).toEqual({ pathCacheBytes: 0, motionCacheBytes: 0 });
    expect(scheduler.pendingCount).toBe(0);
  },
);

it("restarts a suspended candidate query when membership changes its indexed generation", () => {
  const { fixture, port, state, query, work } = createIndexedVisibilityState();
  const cancel = vi.spyOn(SpatialQueryCursor.prototype, "cancel");
  try {
    expect(state.query(BOUNDS, BOUNDS, false, 8, () => work.indexedVisits).pending).toBe(true);
    const id = fixture.ids[0]!;
    const record = fixture.store.get(id)!;
    fixture.store.remove([id]);
    expect(fixture.store.get(id)).toBeUndefined();
    state.releaseId(id);
    state.invalidateForChanges(record.bounds, null, id);
    expect(cancel).toHaveBeenCalledOnce();
    const result = state.query(BOUNDS, BOUNDS, false);
    expect(result.pending).toBeUndefined();
    expect(state.contains(id)).toBe(false);
    expect(query).toHaveBeenCalledTimes(2);
    state.query({ ...BOUNDS, minY: 2_000, maxY: 2_100 }, undefined, false);
    expect(query).toHaveBeenCalledTimes(3);
  } finally {
    state.release();
    port.release();
    query.mockRestore();
    cancel.mockRestore();
  }
  expect(state.queryMemoryUsage()).toBe(0);
});

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
  const { fixture, port, instrumentation, state, query, work } = createIndexedVisibilityState();
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
  query.mockRestore();
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
