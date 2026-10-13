import { expect, it, vi } from "vitest";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { SceneVisibilityState } from "../../../../src/rendering/scene/visibility-state";
import * as visibleOrder from "../../../../src/rendering/scene/visibility-order";
import { FakeSceneStore, fakeRectangleRecord } from "./fakes";

const BOUNDS = { minX: 0, maxX: 100, minY: 0, maxY: 100 };

it("merges entrants and band changes while unchanged retained ranks skip order validation", () => {
  const store = new FakeSceneStore();
  for (const [id, rank] of [
    ["first", 0],
    ["last", 3],
  ] as const)
    store.records.set(id, fakeRectangleRecord(id, rank, 10));
  const state = new SceneVisibilityState(store, createInstrumentation());
  const original = state.query(BOUNDS).visibility;
  const stable = vi.spyOn(visibleOrder, "retainedVisibleOrderStable");
  const sort = vi.spyOn(visibleOrder, "sortVisibleBand");
  try {
    const entrant = fakeRectangleRecord("entrant", 1, 10);
    store.records.set(entrant.id, entrant);
    state.invalidateForChanges(null, entrant.bounds, entrant.id);
    const entered = state.query(BOUNDS);
    expect(entered.visibility.content.ids).toEqual(["first", "entrant", "last"]);
    expect(entered.delta).toEqual({ entered: ["entrant"], exited: [] });
    store.records.set(entrant.id, { ...entrant, band: "highlight" });
    state.invalidateForChanges(entrant.bounds, entrant.bounds, entrant.id);
    const changed = state.query(BOUNDS);
    expect(changed.visibility.content.ids).toEqual(["first", "last"]);
    expect(changed.visibility.highlight.ids).toEqual(["entrant"]);
    expect(original.content.ids).toEqual(["first", "last"]);
    expect(stable).not.toHaveBeenCalled();
    expect(sort).not.toHaveBeenCalled();
  } finally {
    stable.mockRestore();
    sort.mockRestore();
    state.release();
  }
});

it("validates changed dense ranks before merging and sorts true reorders without mutating published IDs", () => {
  const store = new FakeSceneStore();
  const first = fakeRectangleRecord("first", 0, 10);
  const last = fakeRectangleRecord("last", 1, 10);
  for (const record of [first, last]) store.records.set(record.id, record);
  const state = new SceneVisibilityState(store, createInstrumentation());
  const original = state.query(BOUNDS).visibility.content.ids;
  store.records.set(last.id, { ...last, rank: 2 });
  const entrant = fakeRectangleRecord("entrant", 1, 10);
  store.records.set(entrant.id, entrant);
  state.invalidateForChanges(null, entrant.bounds, entrant.id);
  expect(state.query(BOUNDS).visibility.content.ids).toEqual(["first", "entrant", "last"]);
  store.records.set(first.id, { ...first, rank: 3 });
  state.invalidateStagedOrder();
  state.invalidateForChanges(first.bounds, first.bounds, first.id);
  const reordered = state.query(BOUNDS);
  expect(reordered.delta).toBeUndefined();
  expect(reordered.visibility.content.ids).toEqual(["entrant", "last", "first"]);
  store.records.set(last.id, { ...last, rank: 0 });
  expect(state.resortCurrent().content.ids).toEqual(["last", "entrant", "first"]);
  expect(reordered.visibility.content.ids).toEqual(["entrant", "last", "first"]);
  expect(original).toEqual(["first", "last"]);
  state.release();
});

it("keeps equal-rank tie order through culling and replaces stale staged records after an order change", () => {
  const store = new FakeSceneStore();
  for (const id of ["z", "a", "middle"]) store.records.set(id, fakeRectangleRecord(id, 1, 10));
  const state = new SceneVisibilityState(store, createInstrumentation());
  const original = state.query(BOUNDS).visibility.content.ids;
  expect(original).toEqual(["a", "middle", "z"]);
  state.invalidateForChanges(BOUNDS, BOUNDS);
  let clock = 0;
  const get = vi.spyOn(store, "get").mockImplementation((id) => {
    clock += 1;
    const record = store.records.get(id);
    return record === undefined ? undefined : { ...record };
  });
  expect(state.query(BOUNDS, BOUNDS, false, 1, () => clock).pending).toBe(true);
  const record = store.records.get("z")!;
  store.records.set(record.id, { ...record, rank: 0 });
  state.invalidateStagedOrder();
  expect(state.query(BOUNDS).visibility.content.ids).toEqual(["z", "a", "middle"]);
  expect(original).toEqual(["a", "middle", "z"]);
  const narrow = { ...BOUNDS, minX: 80 };
  expect(state.query(narrow).visibility.content.count).toBe(0);
  expect(state.query(BOUNDS).visibility.content.ids).toEqual(["z", "a", "middle"]);
  get.mockRestore();
  state.release();
  expect(state.queryMemoryUsage()).toBe(0);
});
