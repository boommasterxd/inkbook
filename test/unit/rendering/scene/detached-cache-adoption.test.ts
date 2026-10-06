import { expect, it, vi } from "vitest";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { DetachedSceneElementCache } from "../../../../src/rendering/scene/detached-element-cache";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import {
  createMountedElement,
  type MountedSceneElement,
} from "../../../../src/rendering/scene/mounted-element";
import { SceneDom } from "../../../../src/rendering/scene/scene-dom";
import { ScenePathCache } from "../../../../src/rendering/scene/path-cache";
import { SceneVisibilityReconciler } from "../../../../src/rendering/scene/scene-visibility-reconciler";
import { SceneVisibilityState } from "../../../../src/rendering/scene/visibility-state";
import type { SceneStorePort } from "../../../../src/rendering/scene/types";
import { createTestStroke } from "../../../fixtures/persistence/worker-snapshot";
import { arrow } from "../../domain/schema/fixtures";
import {
  asElement,
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  fakeNode,
  fakeRectangleRecord,
} from "./fakes";

const TOP = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
const END = { ...TOP, minY: 1_000, maxY: 1_100 };

function adoptionScene(coldRemote = false, multipartExit = false) {
  const dom = new SceneDom(asElement(new FakeNode(new FakeDocument(), "div")), "Canvas", {});
  const store: FakeSceneStore & Pick<SceneStorePort, "prepareScenePaths"> = new FakeSceneStore();
  const instrumentation = createInstrumentation();
  const entries = Array.from({ length: 4 }, (_, rank) => {
    const rectangle = fakeRectangleRecord(`node-${rank}`, rank, 20, rank < 2 ? 50 : 1_050);
    const record =
      multipartExit && rank === 2
        ? {
            ...rectangle,
            element: {
              ...arrow(500),
              id: rectangle.id,
              start: { x: 20, y: 1_050 },
              end: { x: 40, y: 1_050 },
            },
          }
        : rectangle;
    store.records.set(record.id, record);
    const entry = createMountedElement(
      dom.ownerDocument,
      record,
      buildElementPathParts(record.element),
      instrumentation,
    );
    fakeNode(dom.contentGroup).append(...entry.paths.map(({ node }) => fakeNode(node)));
    return entry;
  });
  const measure = new DetachedSceneElementCache();
  measure.retain(entries[2]!);
  const maximumBytes = measure.statistics().bytes * 2;
  measure.release();
  const cache = new DetachedSceneElementCache(maximumBytes);
  const mounted = new Map<string, MountedSceneElement>();
  for (const entry of entries) {
    if (entry.rank < 2) expect(cache.retainConnected(entry, store)).toBe(true);
    else {
      cache.registerMounted(entry, store);
      mounted.set(entry.id, entry);
    }
  }
  if (coldRemote) {
    const id = "cold";
    store.records.set(id, {
      ...fakeRectangleRecord(id, 4, 20, 50),
      element: { ...createTestStroke(), id, points: [20, 50, 0.5, 30, 60, 1] },
    });
    store.prepareScenePaths = () => new Promise(() => undefined);
  }
  const visibility = new SceneVisibilityState(store, instrumentation);
  visibility.query(END);
  const paths = new ScenePathCache();
  const exitState = { ready: true };
  const reconciler = new SceneVisibilityReconciler({
    dom,
    store,
    instrumentation,
    visibility,
    mounted,
    detachedCache: cache,
    pathCache: paths,
    orderDirty: { content: new Set(), highlight: new Set() },
    isExitReady: () => exitState.ready,
  });
  const target = visibility.query(TOP);
  reconciler.replace(target.visibility, true, target.delta);
  return {
    dom,
    store,
    entries,
    cache,
    mounted,
    visibility,
    paths,
    reconciler,
    maximumBytes,
    exitState,
  };
}

function drain(fixture: ReturnType<typeof adoptionScene>) {
  for (
    let rounds = 0;
    fixture.reconciler.hasPendingWork || fixture.cache.hasPendingCleanup;
    rounds += 1
  ) {
    expect(rounds).toBeLessThan(20);
    const publication = { remainingRoots: 192, remainingRemovals: 64 };
    fixture.cache.flushEvictions(20, () => 0, publication);
    fixture.reconciler.reconcile(20, () => 0, new Map(), new Map(), publication);
    expect(fixture.cache.statistics().bytes).toBeLessThanOrEqual(fixture.maximumBytes);
  }
}

function release(fixture: ReturnType<typeof adoptionScene>) {
  fixture.reconciler.release();
  fixture.cache.dispose();
  fixture.paths.release();
  fixture.visibility.release();
  fixture.dom.release();
  expect(fixture.cache.memoryUsage()).toBe(0);
}

function pauseWarmAdoption(cache: DetachedSceneElementCache) {
  let time = 0;
  const originalRestore = cache.restoreConnected.bind(cache);
  const restore = vi.spyOn(cache, "restoreConnected").mockImplementation((record) => {
    const entry = originalRestore(record);
    if (entry !== undefined) time = 10;
    return entry;
  });
  return {
    restore,
    now: () => time,
    setTime: (value: number) => {
      time = value;
    },
  };
}

it("keeps needed roots when stale exits fall back to retention after physical removal", () => {
  const fixture = adoptionScene();
  const { restore, now } = pauseWarmAdoption(fixture.cache);
  const targetNode = fakeNode(fixture.entries[1]!.paths[0]!.node);
  const targetRemoval = vi.spyOn(targetNode, "remove");
  try {
    fixture.reconciler.reconcile(10, now, new Map(), new Map(), { remainingRoots: 192 });
    restore.mockRestore();
    for (const id of ["node-2", "node-3"]) {
      const record = fixture.store.get(id)!;
      fixture.store.records.set(id, { ...record, geometryVersion: 2 });
    }
    drain(fixture);
    expect(fixture.mounted.get("node-1")).toBe(fixture.entries[1]);
    expect(targetRemoval).not.toHaveBeenCalled();
    expect(fixture.cache.statistics().evictions).toBe(0);
  } finally {
    restore.mockRestore();
    targetRemoval.mockRestore();
    release(fixture);
  }
});

it("uses admitted warm ownership work while cold remote paths and exit retention wait", () => {
  const fixture = adoptionScene(true);
  const { restore, now } = pauseWarmAdoption(fixture.cache);
  try {
    fixture.reconciler.reconcile(10, now, new Map(), new Map(), { remainingRoots: 192 });
    restore.mockRestore();
    expect(fixture.mounted.has("node-1")).toBe(false);
    for (let frame = 0; frame < 4; frame += 1)
      fixture.reconciler.reconcile(10, now, new Map(), new Map(), {
        remainingRoots: 192,
        allowLatePreparedUnit: true,
      });
    expect(fixture.mounted.get("node-1")).toBe(fixture.entries[1]);
    expect(fixture.reconciler.waitingForPaths).toBe(true);
    expect(fixture.cache.statistics().evictions).toBe(0);
  } finally {
    restore.mockRestore();
    release(fixture);
  }
});

it("charges a partial physical exit before admitting another warm root under the late allowance", () => {
  const fixture = adoptionScene(true, true);
  const { restore, now, setTime } = pauseWarmAdoption(fixture.cache);
  try {
    fixture.reconciler.reconcile(10, now, new Map(), new Map(), { remainingRoots: 192 });
    restore.mockRestore();
    const record = fixture.store.get("node-2")!;
    fixture.store.records.set(record.id, { ...record, geometryVersion: 2 });
    fixture.exitState.ready = false;
    let orderReads = 0;
    const originalGet = fixture.mounted.get.bind(fixture.mounted);
    const read = vi.spyOn(fixture.mounted, "get").mockImplementation((id) => {
      if (++orderReads === 2) setTime(20);
      return originalGet(id);
    });
    fixture.reconciler.reconcile(20, now, new Map(), new Map(), { remainingRoots: 192 });
    read.mockRestore();
    expect(fixture.mounted.has("node-1")).toBe(false);
    fixture.exitState.ready = true;
    const exiting = fixture.entries[2]!;
    const exitingNode = fakeNode(exiting.paths[exiting.paths.length - 1]!.node);
    const originalRemove = exitingNode.remove.bind(exitingNode);
    const remove = vi.spyOn(exitingNode, "remove").mockImplementation(() => {
      originalRemove();
      setTime(30);
    });
    const publication = { remainingRoots: 192, remainingRemovals: 64, allowLatePreparedUnit: true };
    try {
      fixture.reconciler.reconcile(20, now, new Map(), new Map(), publication);
      expect(remove).toHaveBeenCalledOnce();
      expect(fixture.entries[2]!.detachedPathCount).toBe(1);
      expect(publication.remainingRemovals).toBe(63);
      expect(fixture.mounted.has("node-2")).toBe(true);
      expect(fixture.mounted.has("node-1")).toBe(false);
    } finally {
      remove.mockRestore();
    }
  } finally {
    restore.mockRestore();
    release(fixture);
  }
});

it.each(["geometry", "paint", "rank", "band"] as const)(
  "lets needed cache ownership enter the %s repair path without blocking exit cleanup",
  (change) => {
    const fixture = adoptionScene();
    const record = fixture.store.get("node-1")!;
    fixture.store.records.set(record.id, {
      ...record,
      ...(change === "geometry" ? { geometryVersion: 2 } : {}),
      ...(change === "paint" ? { paintVersion: 2 } : {}),
      ...(change === "rank" ? { rank: 10 } : {}),
      ...(change === "band" ? { band: "highlight" as const } : {}),
    });
    if (change === "rank") fixture.cache.invalidateRanks();
    const original = fixture.entries[1]!;
    try {
      drain(fixture);
      expect([...fixture.mounted.keys()].sort()).toEqual(["node-0", "node-1"]);
      expect(fixture.cache.hasPendingCleanup).toBe(false);
      expect(fixture.cache.statistics().evictions).toBe(0);
      expect(fixture.mounted.get(record.id) === original).toBe(
        change !== "geometry" && change !== "band",
      );
      expect(fixture.mounted.get(record.id)).toMatchObject({
        geometryVersion: change === "geometry" ? 2 : 1,
        paintVersion: change === "paint" ? 2 : 1,
        band: change === "band" ? "highlight" : "content",
        rank: change === "rank" ? 10 : 1,
      });
    } finally {
      release(fixture);
    }
  },
);

it.each(["retarget", "disabled", "cancel"] as const)(
  "releases adoption protection on %s after the original deadline ends a warm slice",
  (action) => {
    const fixture = adoptionScene();
    const { restore, now } = pauseWarmAdoption(fixture.cache);
    try {
      fixture.reconciler.reconcile(10, now, new Map(), new Map(), { remainingRoots: 0 });
      expect(fixture.mounted.has("node-0")).toBe(true);
      expect(fixture.mounted.has("node-1")).toBe(false);
      restore.mockRestore();
      if (action === "retarget") {
        const target = fixture.visibility.query(END);
        fixture.reconciler.replace(target.visibility, true, target.delta);
      } else if (action === "disabled") fixture.cache.setRetentionEnabled(false);
      else {
        fixture.reconciler.cancel();
        expect(fixture.cache.retainConnected(fixture.entries[2]!, fixture.store)).toBe(true);
        expect(fixture.cache.retainConnected(fixture.entries[3]!, fixture.store)).toBe(false);
        expect(fixture.cache.isPendingRemoval("node-1")).toBe(true);
      }
      drain(fixture);
      expect(fixture.cache.hasPendingCleanup).toBe(false);
      if (action !== "cancel") {
        expect([...fixture.mounted.keys()].sort()).toEqual(
          action === "retarget" ? ["node-2", "node-3"] : ["node-0", "node-1"],
        );
      }
    } finally {
      restore.mockRestore();
      release(fixture);
    }
  },
);

it("stops capacity retirement at the first needed owner and shares pending removal admission", () => {
  const fixture = adoptionScene();
  const incoming = fixture.entries[2]!;
  const needed = vi.fn((id: string) => id === "node-0");
  const remove = vi.spyOn(FakeNode.prototype, "remove");
  try {
    const empty = new DetachedSceneElementCache(fixture.maximumBytes);
    const oversized = new DetachedSceneElementCache(1);
    expect(empty.needsVisibleAdoption(incoming, needed)).toBe(false);
    expect(oversized.needsVisibleAdoption(incoming, needed)).toBe(false);
    expect(fixture.cache.needsVisibleAdoption(incoming, () => false)).toBe(false);
    empty.dispose();
    oversized.dispose();
    expect(fixture.cache.retainConnected(incoming, fixture.store, needed)).toBe(false);
    expect(fixture.cache.needsVisibleAdoption(incoming, needed)).toBe(true);
    expect(needed).toHaveBeenCalledTimes(3);
    expect(fixture.cache.hasPendingCleanup).toBe(false);
    expect(fixture.cache.restoreConnected(fixture.store.get("node-0")!)).toBe(fixture.entries[0]);
    expect(fixture.cache.retainConnected(incoming, fixture.store, needed)).toBe(true);
    needed.mockClear();
    expect(fixture.cache.retainConnected(fixture.entries[3]!, fixture.store, needed)).toBe(false);
    expect(fixture.cache.isPendingRemoval("node-1")).toBe(true);
    const queuedBytes = fixture.cache.statistics().bytes;
    expect(
      fixture.cache.flushEvictions(10, () => 0, { remainingRoots: 0, remainingRemovals: 0 }),
    ).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    expect(fixture.cache.statistics().bytes).toBe(queuedBytes);
    expect(queuedBytes).toBeLessThanOrEqual(fixture.maximumBytes);
    expect(
      fixture.cache.flushEvictions(10, () => 0, { remainingRoots: 0, remainingRemovals: 1 }),
    ).toBe(false);
    expect(remove).toHaveBeenCalledOnce();
    expect(fixture.cache.retainConnected(fixture.entries[3]!, fixture.store, needed)).toBe(true);
    expect(needed).toHaveBeenCalledOnce();
    fixture.cache.setRetentionEnabled(false);
    expect(fixture.cache.needsVisibleAdoption(incoming, needed)).toBe(false);
  } finally {
    remove.mockRestore();
    release(fixture);
  }
});

it("stops a multipart capacity reservation after retiring an unrelated older root", () => {
  const fixture = adoptionScene();
  const record = fixture.store.get("node-2")!;
  const parts = buildElementPathParts(record.element);
  const incoming = createMountedElement(
    fixture.dom.ownerDocument,
    record,
    [...parts, ...parts],
    createInstrumentation(),
  );
  fakeNode(fixture.dom.contentGroup).append(...incoming.paths.map(({ node }) => fakeNode(node)));
  const needed = vi.fn((id: string) => id === "node-1");
  try {
    expect(fixture.cache.retainConnected(incoming, fixture.store, needed)).toBe(false);
    expect(needed).toHaveBeenCalledTimes(2);
    expect(fixture.cache.statistics().evictions).toBe(1);
    expect(fixture.cache.isPendingRemoval("node-0")).toBe(true);
    expect(fixture.cache.isPendingRemoval("node-1")).toBe(false);
    expect(
      fixture.cache.flushEvictions(10, () => 0, { remainingRoots: 0, remainingRemovals: 1 }),
    ).toBe(false);
    expect(fixture.cache.needsVisibleAdoption(incoming, needed)).toBe(true);
    expect(fixture.cache.restoreConnected(fixture.store.get("node-1")!)).toBe(fixture.entries[1]);
    expect(fixture.cache.retainConnected(incoming, fixture.store, needed)).toBe(true);
    expect(fixture.cache.statistics().bytes).toBeLessThanOrEqual(fixture.maximumBytes);
  } finally {
    release(fixture);
  }
});
