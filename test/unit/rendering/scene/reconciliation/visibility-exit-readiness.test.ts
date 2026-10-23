import { expect, it, vi } from "vitest";
import { createInstrumentation } from "../../../../../src/rendering/scene/instrumentation";
import {
  createMountedElement,
  type MountedSceneElement,
} from "../../../../../src/rendering/scene/content/mounted-element";
import { VisibilityExitReadiness } from "../../../../../src/rendering/scene/reconciliation/visibility-exit-readiness";
import { SceneElementFades } from "../../../../../src/rendering/scene/presentation/scene-element-fades";
import {
  prepareVisibilityCleanup,
  removeOrderedVisibilityExits,
} from "../../../../../src/rendering/scene/reconciliation/visibility-reconciliation-commit";
import type { PendingReconciliation } from "../../../../../src/rendering/scene/reconciliation/reconciliation-state";
import { MountSlice } from "../../../../../src/rendering/scene/reconciliation/mount-slice";
import { asDocument, FakeDocument, FakeSceneStore, fakeRectangleRecord } from "../fakes";

function mountedEntries(ids: readonly string[], instrumentation = createInstrumentation()) {
  const owner = asDocument(new FakeDocument());
  return ids.map((id, rank) =>
    createMountedElement(
      owner,
      fakeRectangleRecord(id, rank, 10),
      [{ d: "M0 0L1 1", paint: "stroke" }],
      instrumentation,
    ),
  );
}

function createExitPublicationPorts(
  mounted: Map<string, MountedSceneElement>,
  instrumentation: ReturnType<typeof createInstrumentation>,
) {
  return {
    mounted,
    instrumentation,
    store: new FakeSceneStore(),
    pathCache: { invalidate: vi.fn(), retain: vi.fn() },
    visibility: { contains: () => false, releaseId: vi.fn() },
  };
}

function setup(count: number, finishForRank = (_rank: number) => 0) {
  const ids = Array.from({ length: count }, (_, rank) => `exit-${rank}`);
  const pending = { exitIds: [...ids], exitIndex: 0 };
  const mounted = new Map(ids.map((id) => [id, { detachedPathCount: 0 } as MountedSceneElement]));
  const finishes = new Map(ids.map((id, rank) => [id, finishForRank(rank)]));
  const instrumentation = createInstrumentation();
  const index = new VisibilityExitReadiness(
    pending,
    mounted,
    (id) => finishes.get(id) ?? 0,
    instrumentation,
  );
  const frame = { deadline: Infinity, now: () => 0, isExit: () => true };
  const consume = () => {
    const id = pending.exitIds[pending.exitIndex++]!;
    index.consume(id);
    mounted.delete(id);
    return id;
  };
  return { ids, pending, mounted, finishes, instrumentation, index, frame, consume };
}

it("selects ready ranks past a waiting head and updates swapped positions in place", () => {
  const fixture = setup(4, (rank) => (rank < 2 ? Infinity : 0));
  expect(fixture.index.select(fixture.frame)).toBe(true);
  expect(fixture.consume()).toBe(fixture.ids[2]);
  fixture.index.update(fixture.ids[0]!, 0);
  expect(fixture.index.select(fixture.frame)).toBe(true);
  expect(fixture.consume()).toBe(fixture.ids[0]);
  expect(fixture.index.select(fixture.frame)).toBe(true);
  expect(fixture.consume()).toBe(fixture.ids[3]);
  expect(fixture.index.select(fixture.frame)).toBe(false);
  fixture.index.update(fixture.ids[1]!, 20);
  expect(fixture.index.select({ ...fixture.frame, now: () => 19 })).toBe(false);
  expect(fixture.index.select({ ...fixture.frame, now: () => 20 })).toBe(true);
  expect(fixture.consume()).toBe(fixture.ids[1]);
  expect(fixture.index.select(fixture.frame)).toBe(true);
  expect(fixture.index.memoryUsage()).toBe(0);
});

it("bounds the real heap work and ownership through 10K updates, consumption and release", () => {
  const count = 10_000;
  const fixture = setup(count, () => Infinity);
  expect(fixture.index.select(fixture.frame)).toBe(false);
  expect(fixture.index.memoryUsage()).toBe(count * 136);
  for (let update = 0; update < count * 2; update += 1) {
    const rank = (update * 7919) % count;
    fixture.index.update(fixture.ids[rank]!, update < count ? rank + 1 : 0);
    expect(fixture.index.memoryUsage()).toBe(count * 136);
  }
  for (let rank = 0; rank < count; rank += 1) {
    expect(fixture.index.select(fixture.frame)).toBe(true);
    expect(fixture.consume()).toBe(fixture.ids[rank]);
  }
  expect(fixture.index.memoryUsage()).toBe(0);
  expect(fixture.instrumentation.exitReadinessVisits).toBeLessThanOrEqual(count * 5);
  expect(fixture.instrumentation.exitReadinessComparisons).toBeLessThanOrEqual(
    count * 12 * Math.ceil(Math.log2(count)),
  );
  fixture.index.update("missing", 0);
  fixture.index.consume("missing");
  fixture.index.release();
  expect(fixture.index.memoryUsage()).toBe(0);
});

it("classifies and promotes under the supplied shared deadline without losing pending exits", () => {
  const fixture = setup(12, (rank) => rank + 20);
  let clock = 0;
  const index = new VisibilityExitReadiness(
    fixture.pending,
    fixture.mounted,
    (id) => {
      clock += 1;
      return fixture.finishes.get(id)!;
    },
    fixture.instrumentation,
  );
  const frame = { ...fixture.frame, deadline: 2, now: () => clock };
  expect(index.select(frame)).toBe(false);
  expect(fixture.instrumentation.exitReadinessVisits).toBe(2);
  expect(index.memoryUsage()).toBe(2 * 136);
  expect(index.select({ ...frame, deadline: 12 })).toBe(false);
  expect(index.memoryUsage()).toBe(12 * 136);
  let comparisons = fixture.instrumentation.exitReadinessComparisons;
  Object.defineProperty(fixture.instrumentation, "exitReadinessComparisons", {
    get: () => comparisons,
    set: (value: number) => {
      comparisons = value;
      clock += 1;
    },
  });
  clock = 40;
  expect(index.select({ ...frame, deadline: 41 })).toBe(false);
  expect(fixture.pending.exitIndex).toBe(0);
  expect(index.memoryUsage()).toBe(12 * 136);
  expect(index.select({ ...frame, deadline: Infinity })).toBe(true);
  expect(fixture.pending.exitIds[0]).toBe(fixture.ids[0]);
  index.release();
  expect(index.memoryUsage()).toBe(0);
});

it("pins a partially detached cursor and preserves every unconsumed ID on cancellation", () => {
  const fixture = setup(3, () => Infinity);
  fixture.mounted.get(fixture.ids[0]!)!.detachedPathCount = 1;
  expect(fixture.index.select(fixture.frame)).toBe(true);
  expect(fixture.pending.exitIds[0]).toBe(fixture.ids[0]);
  fixture.consume();
  expect(fixture.index.select(fixture.frame)).toBe(false);
  fixture.index.release();
  expect(fixture.index.memoryUsage()).toBe(0);
  expect(new Set(fixture.pending.exitIds.slice(fixture.pending.exitIndex))).toEqual(
    new Set(fixture.ids.slice(1)),
  );
  fixture.index.update(fixture.ids[1]!, 0);
  expect(fixture.index.memoryUsage()).toBe(0);
});

it("admits missing and protected IDs for cleanup without waiting for their fade", () => {
  const fixture = setup(3, () => Infinity);
  fixture.mounted.delete(fixture.ids[0]!);
  const frame = { ...fixture.frame, isExit: (id: string) => id !== fixture.ids[1] };
  expect(fixture.index.select(frame)).toBe(true);
  expect(fixture.consume()).toBe(fixture.ids[0]);
  expect(fixture.index.select(frame)).toBe(true);
  expect(fixture.consume()).toBe(fixture.ids[1]);
  expect(fixture.index.select(frame)).toBe(false);
  fixture.index.release();
});

it("rechecks a formerly protected fade and removes other ready IDs in the same reconciliation", () => {
  const instrumentation = createInstrumentation();
  const entries = mountedEntries(["protected", "ready"], instrumentation);
  const mounted = new Map(entries.map((entry) => [entry.id, entry]));
  const fades = new SceneElementFades(mounted);
  fades.set(["protected"], 500);
  let protectedPreview = true;
  const pending = {
    exitIds: ["protected", "ready"],
    exitIndex: 0,
    exitScanComplete: true,
    exitOrderPrepared: false,
  } as PendingReconciliation;
  const removed = vi.fn();
  const options = {
    ...createExitPublicationPorts(mounted, instrumentation),
    isExitReady: (id: string, now: number) => fades.isExitReady(id, now),
    exitReadyAt: (id: string) => {
      if (id === "ready") protectedPreview = false;
      return fades.readyAt(id);
    },
  } as unknown as Parameters<typeof removeOrderedVisibilityExits>[1];
  expect(
    removeOrderedVisibilityExits(pending, options, {
      deadline: Infinity,
      now: () => 0,
      isExit: (id) => id !== "protected" || !protectedPreview,
      onRemoved: removed,
    }),
  ).toBe(false);
  expect(removed).toHaveBeenCalledExactlyOnceWith("ready");
  expect(mounted.has("protected")).toBe(true);
  expect(pending.exitIds[pending.exitIndex]).toBe("protected");
  pending.exitReadiness!.release();
  fades.release();
});

it.each(["classification", "promotion"] as const)(
  "defers DOM removal and further staging when the last %s unit consumes the deadline",
  (phase) => {
    const instrumentation = createInstrumentation();
    const entries = mountedEntries(["first", "second"], instrumentation);
    const mounted = new Map(entries.map((entry) => [entry.id, entry]));
    let clock = 0;
    const pending = {
      exitIds: entries.map(({ id }) => id),
      exitIndex: 0,
      exitScanComplete: true,
      exitOrderPrepared: false,
      cleanupFirst: true,
    } as PendingReconciliation;
    const options = {
      ...createExitPublicationPorts(mounted, instrumentation),
      exitReadyAt: () => {
        if (phase === "classification") clock += 1;
        return phase === "promotion" ? 1 : 0;
      },
    } as unknown as Parameters<typeof removeOrderedVisibilityExits>[1];
    const remove = vi.spyOn(entries[0]!.paths[0]!.node, "remove");
    const frame = { deadline: 2, now: () => clock, isExit: () => true };
    if (phase === "promotion") {
      expect(removeOrderedVisibilityExits(pending, options, frame)).toBe(false);
      clock = 1;
      let comparisons = instrumentation.exitReadinessComparisons;
      Object.defineProperty(instrumentation, "exitReadinessComparisons", {
        get: () => comparisons,
        set: (value: number) => {
          comparisons = value;
          clock += 1;
        },
      });
    }
    const collect = vi.fn();
    const slice = new MountSlice(frame.deadline, frame.now);
    expect(
      prepareVisibilityCleanup(pending, slice, {
        collect,
        remove: () => removeOrderedVisibilityExits(pending, options, frame),
      }),
    ).toBe("deadline");
    expect(slice.elements).toBe(1);
    expect(collect).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(mounted.size).toBe(2);
    expect(removeOrderedVisibilityExits(pending, options, { ...frame, deadline: clock + 1 })).toBe(
      true,
    );
    expect(mounted.size).toBe(0);
    pending.exitReadiness!.release();
    remove.mockRestore();
  },
);
