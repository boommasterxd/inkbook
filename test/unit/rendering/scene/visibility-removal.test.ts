import { expect, it, vi } from "vitest";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { SceneVisibilityState } from "../../../../src/rendering/scene/visibility-state";
import { VisibilityRemovalReuse } from "../../../../src/rendering/scene/visibility-removal";
import { commitVisibleBands } from "../../../../src/rendering/scene/visibility-order";
import { createMountedElement } from "../../../../src/rendering/scene/mounted-element";
import { FakeDocument, FakeSceneStore, fakeRectangleRecord } from "./fakes";

const BOUNDS = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

function publishedState(count = 4, highlightCount = 0) {
  const store = new FakeSceneStore();
  for (let index = 0; index < count; index += 1) {
    const id = String(index);
    store.records.set(id, {
      ...fakeRectangleRecord(id, index, 10),
      band: index < highlightCount ? "highlight" : "content",
    });
  }
  const instrumentation = createInstrumentation();
  const state = new SceneVisibilityState(store, instrumentation);
  const original = state.query(BOUNDS).visibility;
  const proof = state.removalReuse.beginCommit(original);
  state.removalReuse.finishCommit(original, proof);
  return { state, store, instrumentation, original };
}

function observeMembershipWork(state: SceneVisibilityState) {
  let clock = 0;
  const contains = state.contains.bind(state);
  const visit = vi.spyOn(state, "contains").mockImplementation((id) => {
    clock += 1;
    return contains(id);
  });
  return { now: () => clock, visit };
}

it("filters published IDs with zero spatial, classification, or record reads", () => {
  const { state, store, instrumentation, original } = publishedState();
  store.records.delete("0");
  state.releaseId("0");
  expect(state.beginRemoval()).toBe(true);
  const get = vi.spyOn(store, "get");
  const query = vi.spyOn(store, "query");
  const visits = instrumentation.visibilityCandidateVisits;
  const result = state.query(BOUNDS);
  expect(result.visibility.content.count).toBe(3);
  expect(result.delta).toEqual({ entered: [], exited: ["0"] });
  expect(original.content.ids[0]).toBe("0");
  expect(original.content.count).toBe(4);
  expect(get).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
  expect(instrumentation.visibilityCandidateVisits).toBe(visits);
  expect(state.removalReuse.ranksDirty).toBe(true);
  state.release();
  expect(state.queryMemoryUsage()).toBe(0);
});

it.each(["camera", "order", "geometry", "release", "second-removal"] as const)(
  "discards a partial copy after %s without mutating the old snapshot",
  (change) => {
    const { state, store, original } = publishedState();
    state.releaseId("0");
    store.records.delete("0");
    expect(state.beginRemoval()).toBe(true);
    const { now, visit } = observeMembershipWork(state);
    expect(state.query(BOUNDS, BOUNDS, true, 2, now).pending).toBe(true);
    visit.mockRestore();
    expect(state.removalReuse.memoryUsage()).toBeGreaterThan(0);
    if (change === "order") state.invalidateStagedOrder();
    if (change === "geometry") state.invalidateForChanges(BOUNDS, BOUNDS, "1");
    if (change === "release") state.release();
    if (change === "second-removal") {
      expect(state.beginRemoval()).toBe(false);
      state.releaseId("1");
      store.records.delete("1");
      state.invalidateForChanges(BOUNDS, null, "1");
    }
    const bounds = change === "camera" ? { ...BOUNDS, maxX: 101 } : BOUNDS;
    const result = state.query(bounds);
    expect(result.visibility.content.ids).toEqual(
      change === "second-removal" ? ["2", "3"] : ["1", "2", "3"],
    );
    expect(original.content.ids).toEqual(["0", "1", "2", "3"]);
    expect(state.removalReuse.memoryUsage()).toBe(0);
    state.release();
  },
);

it("reuses a released slot across both bands after cancelling a partial removal copy", () => {
  const { state, store, original } = publishedState(4, 2);
  store.records.delete("3");
  state.releaseId("3");
  expect(state.beginRemoval()).toBe(true);
  const { now, visit } = observeMembershipWork(state);
  try {
    expect(state.query(BOUNDS, BOUNDS, true, 3, now).pending).toBe(true);
    expect(visit.mock.calls.map(([id]) => id)).toEqual(["0", "1", "2"]);
    expect(state.removalReuse.memoryUsage()).toBeGreaterThan(0);
    visit.mockRestore();
    const replacement = {
      ...fakeRectangleRecord("replacement", 2, 10),
      band: "highlight" as const,
    };
    store.records.set(replacement.id, replacement);
    state.invalidateForChanges(null, replacement.bounds, replacement.id);
    expect(state.removalReuse.memoryUsage()).toBe(0);
    const inserted = state.query(BOUNDS).visibility;
    expect(inserted.highlight.ids).toEqual(["0", "1", replacement.id]);
    expect(inserted.content.ids).toEqual(["2"]);
    expect(state.contains("3")).toBe(false);
    expect(state.contains(replacement.id)).toBe(true);
    state.removalReuse.finishCommit(inserted, state.removalReuse.beginCommit(inserted));
    store.records.delete(replacement.id);
    state.releaseId(replacement.id);
    expect(state.beginRemoval()).toBe(true);
    const result = state.query(BOUNDS);
    expect(result.visibility.highlight.ids).toEqual(["0", "1"]);
    expect(result.visibility.content.ids).toEqual(["2"]);
    expect(result.delta).toEqual({ entered: [], exited: [replacement.id] });
    expect(inserted.highlight.ids).toEqual(["0", "1", replacement.id]);
    expect(inserted.content.ids).toEqual(["2"]);
    expect(original.highlight.ids).toEqual(["0", "1"]);
    expect(original.content.ids).toEqual(["2", "3"]);
  } finally {
    visit.mockRestore();
    state.release();
  }
  expect(state.queryMemoryUsage()).toBe(0);
});

it("rejects stale publication proofs and incomplete classification", () => {
  const { state, store, original } = publishedState();
  const generation = state.removalReuse.beginCommit(original);
  state.removalReuse.invalidate();
  state.removalReuse.finishCommit(original, generation);
  expect(state.beginRemoval()).toBe(false);
  state.invalidateForChanges(BOUNDS, BOUNDS);
  let clock = 0;
  const get = vi.spyOn(store, "get").mockImplementation((id) => {
    clock += 1;
    return store.records.get(id);
  });
  expect(state.query(BOUNDS, BOUNDS, false, 1, () => clock).pending).toBe(true);
  expect(state.beginRemoval()).toBe(false);
  get.mockRestore();
  state.release();
});

it("refreshes rank caches from the existing commit reads before merging camera entrants", () => {
  const store = new FakeSceneStore();
  const records = [
    fakeRectangleRecord("removed", 0, 10),
    fakeRectangleRecord("middle", 1, 10),
    fakeRectangleRecord("entrant", 2, 150),
    fakeRectangleRecord("last", 3, 10),
  ];
  for (const record of records) store.records.set(record.id, record);
  const state = new SceneVisibilityState(store, createInstrumentation());
  const original = state.query(BOUNDS).visibility;
  state.removalReuse.finishCommit(original, state.removalReuse.beginCommit(original));
  store.records.delete("removed");
  for (const record of records.slice(1))
    store.records.set(record.id, { ...record, rank: record.rank - 1 });
  state.releaseId("removed");
  expect(state.beginRemoval()).toBe(true);
  const visibility = state.query(BOUNDS).visibility;
  const document = new FakeDocument() as unknown as Document;
  const mounted = new Map(
    ["middle", "last"].map((id) => [
      id,
      createMountedElement(
        document,
        store.records.get(id)!,
        [{ d: "M0 0L10 10", paint: "stroke" }],
        createInstrumentation(),
      ),
    ]),
  );
  const get = vi.spyOn(store, "get");
  commitVisibleBands(
    { content: [], highlight: [] },
    { content: 0, highlight: 0 },
    visibility,
    { mounted, store, epoch: 1 },
    state.removalReuse,
  );
  expect(get).toHaveBeenCalledTimes(2);
  expect(state.removalReuse.ranksDirty).toBe(false);
  expect(state.query({ ...BOUNDS, maxX: 200 }).visibility.content.ids).toEqual([
    "middle",
    "entrant",
    "last",
  ]);
  get.mockRestore();
  state.release();
});

it("bounds partial-copy work by the supplied deadline and releases its references on cancellation", () => {
  let clock = 0;
  const current = {
    content: { count: 4, ids: ["a", "b", "c", "d"] },
    highlight: { count: 0, ids: [] },
  };
  const contains = vi.fn((id: string) => {
    clock += 1;
    return id !== "a";
  });
  const reuse = new VisibilityRemovalReuse({
    current: () => current,
    bounds: () => BOUNDS,
    ready: () => true,
    contains,
    updateRank: () => undefined,
  });
  reuse.finishCommit(current, reuse.beginCommit(current));
  expect(reuse.begin()).toBe(true);
  expect(reuse.advance(BOUNDS, 2, () => clock, true)).toBe("pending");
  expect(contains).toHaveBeenCalledTimes(2);
  expect(reuse.memoryUsage()).toBe(16);
  expect(reuse.advance(BOUNDS, 4, () => clock, true)).toBe("pending");
  expect(contains).toHaveBeenCalledTimes(4);
  expect(reuse.advance(BOUNDS, 5, () => clock, true)).toMatchObject({
    content: ["b", "c", "d"],
    exited: ["a"],
  });
  expect(reuse.memoryUsage()).toBe(0);
  reuse.invalidate();
  expect(reuse.begin()).toBe(false);
});
