import { expect, it, vi } from "vitest";
import { SceneEntrantPriority } from "../../../../../src/rendering/scene/visibility/scene-entrant-priority";
import { createInstrumentation } from "../../../../../src/rendering/scene/instrumentation";
import { MountSlice } from "../../../../../src/rendering/scene/reconciliation/mount-slice";
import type { PendingReconciliation } from "../../../../../src/rendering/scene/reconciliation/reconciliation-state";
import { stageVisibilityDelta } from "../../../../../src/rendering/scene/reconciliation/visibility-delta-reconciliation";
import { FakeSceneStore, fakeRectangleRecord } from "../fakes";

const INITIAL_PRIORITY = {
  viewport: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
  direction: { x: 0, y: 1 },
};

function fixture() {
  const store = new FakeSceneStore();
  const candidates = [
    ["ahead", 140],
    ["inside", 20],
    ["late", 70],
    ["tail", 250],
  ] as const;
  for (const [rank, [id, y]] of candidates.entries()) {
    store.records.set(id, fakeRectangleRecord(id, rank, 20, y));
  }
  const mounted = new Set<string>();
  const priority = new SceneEntrantPriority(
    store.records.keys(),
    store,
    mounted,
    createInstrumentation(),
    INITIAL_PRIORITY,
  );
  return { store, mounted, priority };
}

it("publishes the complete viewport heap before overscan and preserves retarget ownership", () => {
  const { store, mounted, priority } = fixture();
  const get = vi.spyOn(store, "get");
  const slice = () => new MountSlice(Infinity, () => 0);
  expect(priority.build(slice(), true)).toBeUndefined();
  expect(get).toHaveBeenCalledTimes(4);
  expect([...priority.upcoming(10)]).toEqual(["inside", "late"]);
  expect(priority.take()).toBe("inside");
  mounted.add("inside");
  priority.release("inside");
  expect([...priority.upcoming(10)]).toEqual(["late"]);
  expect(priority.hasViewportCandidates).toBe(true);
  priority.retarget([], [], {
    viewport: { ...INITIAL_PRIORITY.viewport, minY: 100, maxY: 200 },
    direction: INITIAL_PRIORITY.direction,
  });
  expect(priority.build(slice(), true)).toBeUndefined();
  expect(get).toHaveBeenCalledTimes(4);
  expect(priority.take()).toBe("ahead");
  mounted.add("ahead");
  priority.release("ahead");
  expect(priority.build(slice(), true)).toBeUndefined();
  expect(get).toHaveBeenCalledTimes(4);
  expect([...priority.upcoming(10)]).toEqual(["tail", "late"]);
  for (const id of ["tail", "late"]) {
    expect(priority.take()).toBe(id);
    priority.release(id);
  }
  expect(priority.hasViewportCandidates).toBe(false);
  expect(priority.memoryUsage()).toBe(0);
});

it("stops classification when a viewport read consumes the shared deadline", () => {
  const { store, priority } = fixture();
  let clock = 0;
  const originalGet = store.get.bind(store);
  const get = vi.spyOn(store, "get").mockImplementation((id) => {
    const record = originalGet(id);
    clock += 1;
    return record;
  });
  expect(priority.build(new MountSlice(2, () => clock), true)).toBe("deadline");
  expect(get).toHaveBeenCalledTimes(2);
  expect(priority.build(new MountSlice(6, () => clock), true)).toBeUndefined();
  expect(get).toHaveBeenCalledTimes(4);
  expect(priority.take()).toBe("inside");
});

it("defers candidate reads when the final overscan heap push consumes the shared deadline", () => {
  const { store, priority } = fixture();
  expect(priority.build(new MountSlice(Infinity, () => 0), true)).toBeUndefined();
  for (const id of ["inside", "late"]) {
    expect(priority.take()).toBe(id);
    priority.release(id);
  }
  const pending = {
    delta: { phase: "warm", ids: [], index: 0, deferred: [], priority },
    entrants: new Map(),
  } as unknown as PendingReconciliation;
  const get = vi.spyOn(store, "get");
  const take = vi.spyOn(priority, "take");
  const stage = vi.fn(() => undefined);
  const options = {
    instrumentation: createInstrumentation(),
    mounted: new Map(),
    store,
    visibility: { contains: () => true },
    waiting: () => true,
    publish: () => undefined,
    prepareDeferred: () => undefined,
    stage,
    run: () => {
      throw new Error("Unprepared entries must not be published.");
    },
  };
  const generation = priority.heapGeneration;
  const slice = new MountSlice(2, () => priority.heapGeneration - generation);
  expect(stageVisibilityDelta(pending, slice, new Map(), options)).toBe("deadline");
  expect(priority.heapGeneration - generation).toBe(2);
  expect(take).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
  expect(stage).not.toHaveBeenCalled();
  expect(pending.delta!.ids).toEqual([]);
  expect(priority.count).toBe(2);
  expect([...priority.upcoming(2)]).toEqual(["ahead", "tail"]);

  expect(stageVisibilityDelta(pending, new MountSlice(Infinity, () => 0), new Map(), options)).toBe(
    "paths",
  );
  expect(get.mock.calls.map(([id]) => id)).toEqual(["ahead", "tail", "ahead"]);
  expect(stage).toHaveBeenCalledTimes(3);
  expect(take).toHaveBeenCalledTimes(3);
  expect(pending.delta!.ids).toEqual(["ahead", "tail"]);
  expect(pending.delta!.phase).toBe("paths");
  expect(priority.count).toBe(0);
});

it.each([1, -1])("keeps the complete viewport in direction %s ahead of overscan", (sign) => {
  const { priority } = fixture();
  priority.retarget([], [], {
    viewport: INITIAL_PRIORITY.viewport,
    direction: { x: 0, y: sign },
  });
  const slice = () => new MountSlice(Infinity, () => 0);
  expect(priority.build(slice(), true)).toBeUndefined();
  const viewport = sign === 1 ? ["inside", "late"] : ["late", "inside"];
  expect([...priority.upcoming(10)]).toEqual(viewport);
  for (const id of viewport) {
    expect(priority.build(slice(), true)).toBeUndefined();
    expect(priority.take()).toBe(id);
    priority.release(id);
  }
  const generation = priority.heapGeneration;
  expect(priority.build(new MountSlice(1, () => priority.heapGeneration - generation), true)).toBe(
    "deadline",
  );
  expect(priority.heapGeneration - generation).toBe(1);
  expect([...priority.upcoming(10)]).toEqual([]);
  expect(priority.build(slice(), true)).toBeUndefined();
  for (const id of sign === 1 ? ["ahead", "tail"] : ["tail", "ahead"]) {
    expect(priority.take()).toBe(id);
    priority.release(id);
  }
  expect(priority.memoryUsage()).toBe(0);
});
