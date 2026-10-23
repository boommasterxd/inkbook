import { expect, it, vi } from "vitest";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { DetachedSceneElementCache } from "../../../../src/rendering/scene/content/detached-element-cache";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import {
  createMountedElement,
  type MountedSceneElement,
} from "../../../../src/rendering/scene/content/mounted-element";
import { SceneDom } from "../../../../src/rendering/scene/scene-dom";
import { ScenePathCache } from "../../../../src/rendering/scene/content/path-cache";
import { SceneVisibilityReconciler } from "../../../../src/rendering/scene/reconciliation/scene-visibility-reconciler";
import { SceneVisibilityState } from "../../../../src/rendering/scene/visibility/visibility-state";
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
    return entry;
  });
  const measure = new DetachedSceneElementCache();
  measure.retain(entries[2]!);
  const maximumBytes = measure.statistics().bytes * 2;
  measure.release();
  const cache = new DetachedSceneElementCache(maximumBytes);
  const mounted = new Map<string, MountedSceneElement>();
  for (const entry of entries) {
    if (entry.rank < 2) expect(cache.retain(entry)).toBe(true);
    else {
      fakeNode(dom.contentGroup).append(...entry.paths.map(({ node }) => fakeNode(node)));
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
  for (let rounds = 0; fixture.reconciler.hasPendingWork; rounds += 1) {
    expect(rounds).toBeLessThan(20);
    const publication = { remainingRoots: 192, remainingRemovals: 64 };
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

it.each(["geometry", "paint", "rank", "band"] as const)(
  "repairs a detached %s return before bounded physical exit cleanup",
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
      expect(fixture.cache.statistics().evictions).toBe(0);
      expect(fixture.mounted.get(record.id) === original).toBe(change !== "geometry");
      expect(fixture.mounted.get(record.id)).toMatchObject({
        geometryVersion: change === "geometry" ? 2 : 1,
        paintVersion: change === "paint" ? 2 : 1,
        band: change === "band" ? "highlight" : "content",
        rank: change === "rank" ? 10 : 1,
      });
      expect(fakeNode(fixture.dom.contentGroup).nodes).toHaveLength(change === "band" ? 1 : 2);
      expect(fakeNode(fixture.dom.highlightGroup).nodes).toHaveLength(change === "band" ? 1 : 0);
      expect(
        fixture.entries
          .slice(2)
          .every((entry) => entry.paths.every(({ node }) => node.parentNode === null)),
      ).toBe(true);
    } finally {
      release(fixture);
    }
  },
);

it.each(["cancel", "retarget", "invalidation", "pressure"] as const)(
  "keeps unpublished detached entrants safe through %s",
  (action) => {
    const fixture = adoptionScene();
    let time = 0;
    const originalTake = fixture.cache.take.bind(fixture.cache);
    const take = vi.spyOn(fixture.cache, "take").mockImplementation((record, stats) => {
      const entry = originalTake(record, stats);
      if (entry !== undefined) time = 10;
      return entry;
    });
    try {
      expect(
        fixture.reconciler.reconcile(10, () => time, new Map(), new Map(), {
          remainingRoots: 192,
        }).pending,
      ).toBe(true);
      expect(take).toHaveBeenCalledOnce();
      const entry = take.mock.results[0]!.value as MountedSceneElement;
      expect(entry.paths.every(({ node }) => node.parentNode === null)).toBe(true);
      expect(fixture.mounted.size).toBe(2);
      expect(fakeNode(fixture.dom.contentGroup).nodes).toHaveLength(2);
      take.mockRestore();
      if (action === "invalidation") {
        const record = fixture.store.get(entry.id)!;
        fixture.store.records.set(entry.id, { ...record, geometryVersion: 2 });
        fixture.cache.invalidate(entry.id);
      }
      if (action === "pressure") fixture.cache.setRetentionEnabled(false);
      if (action === "retarget") {
        const target = fixture.visibility.query(END);
        fixture.reconciler.replace(target.visibility, true, target.delta);
      } else fixture.reconciler.cancel();
      expect(entry.paths.every(({ node }) => node.parentNode === null)).toBe(true);
      const restored = fixture.cache.take(fixture.store.get(entry.id)!, createInstrumentation());
      expect(restored).toBe(action === "pressure" || action === "invalidation" ? undefined : entry);
      expect(fakeNode(fixture.dom.contentGroup).nodes).toHaveLength(2);
      expect(fixture.cache.statistics().bytes).toBeLessThanOrEqual(fixture.maximumBytes);
    } finally {
      take.mockRestore();
      release(fixture);
    }
  },
);

it("publishes warm detached roots while remote geometry remains pending", () => {
  const fixture = adoptionScene(true);
  try {
    fixture.reconciler.reconcile(20, () => 0, new Map(), new Map(), { remainingRoots: 192 });
    expect(fixture.mounted.get("node-0")).toBe(fixture.entries[0]);
    expect(fixture.mounted.get("node-1")).toBe(fixture.entries[1]);
    expect(fixture.reconciler.waitingForPaths).toBe(true);
    expect(fixture.cache.statistics().evictions).toBe(0);
  } finally {
    release(fixture);
  }
});

it("admits multipart exit roots to the detached cache only after final removal", () => {
  const fixture = adoptionScene(false, true);
  const exiting = fixture.entries[2]!;
  try {
    fixture.reconciler.reconcile(20, () => 0, new Map(), new Map(), {
      remainingRoots: 192,
      remainingRemovals: 1,
    });
    expect(exiting.detachedPathCount).toBe(1);
    expect(exiting.paths.some(({ node }) => node.parentNode !== null)).toBe(true);
    expect(fixture.mounted.get(exiting.id)).toBe(exiting);
    expect(fixture.cache.retain(exiting)).toBe(false);
    drain(fixture);
    expect(exiting.paths.every(({ node }) => node.parentNode === null)).toBe(true);
    expect(fixture.cache.take(fixture.store.get(exiting.id)!, createInstrumentation())).toBe(
      exiting,
    );
  } finally {
    release(fixture);
  }
});
