import { expect, it, vi } from "vitest";
import { SceneEntrantPriority } from "../../../../../src/rendering/scene/visibility/scene-entrant-priority";
import { SCENE_PUBLICATION_ROOTS_PER_FRAME } from "../../../../../src/rendering/scene/constants";
import { NAVIGATION_PAGE } from "../../../../fixtures/rendering/pressure-navigation";
import {
  createSceneFixture,
  createViewportRectangleStore,
} from "../../../../fixtures/rendering/scene";
import { observeSceneInsertions } from "../../../../fixtures/rendering/scene-publication";
import { fakeNode } from "../../../../unit/rendering/scene/fakes";
import { DetachedSceneElementCache } from "../../../../../src/rendering/scene/content/detached-element-cache";
import { MountSlice } from "../../../../../src/rendering/scene/reconciliation/mount-slice";
import {
  createMountedElement,
  firstPath,
} from "../../../../../src/rendering/scene/content/mounted-element";
import { stagePromotedVisibility } from "../../../../../src/rendering/scene/reconciliation/promoted-visibility-entry";
import type { PendingReconciliation } from "../../../../../src/rendering/scene/reconciliation/reconciliation-state";
import { publishStableEntrantRun } from "../../../../../src/rendering/scene/reconciliation/visibility-publication";
import type { PendingMutationRun } from "../../../../../src/rendering/scene/reconciliation/visibility-publication";
import { SceneVisibilityState } from "../../../../../src/rendering/scene/visibility/visibility-state";
import { buildElementPathParts } from "../../../../../src/domain/geometry/element-path";
import { createDirectPublicationScene } from "../../../../fixtures/rendering/scene-publication";
import { ScenePathCache } from "../../../../../src/rendering/scene/content/path-cache";

it("publishes the ordered viewport before building the 10,000-candidate overscan heap", () => {
  const store = createViewportRectangleStore(10_000, (rank) =>
    rank < SCENE_PUBLICATION_ROOTS_PER_FRAME ? 20 : 200,
  );
  const get = vi.spyOn(store, "get");
  // eslint-disable-next-line @typescript-eslint/unbound-method -- The observation wrapper calls the original with its actual receiver through apply.
  const buildOriginal = SceneEntrantPriority.prototype.build;
  let priorityReads = 0;
  let priorityPushes = 0;
  const build = vi.spyOn(SceneEntrantPriority.prototype, "build").mockImplementation(function (
    this: SceneEntrantPriority,
    ...args: Parameters<SceneEntrantPriority["build"]>
  ) {
    const reads = get.mock.calls.length;
    const generation = this.heapGeneration;
    const result = buildOriginal.apply(this, args);
    priorityReads += get.mock.calls.length - reads;
    priorityPushes += this.heapGeneration - generation;
    return result;
  });
  const viewport = { height: 100, left: 0, top: 0, width: 100 };
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, viewport);
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  let firstPushes = 0;
  const insert = observeSceneInsertions(content, (roots) => {
    if (firstPushes === 0) firstPushes = priorityPushes;
    expect(roots).toBeLessThanOrEqual(SCENE_PUBLICATION_ROOTS_PER_FRAME);
    scheduler.time += 8;
  });
  try {
    scheduler.runNext();
    expect(priorityReads).toBe(10_000);
    expect(firstPushes).toBe(SCENE_PUBLICATION_ROOTS_PER_FRAME);
    expect(priorityPushes).toBe(SCENE_PUBLICATION_ROOTS_PER_FRAME);
    expect(content.nodes.length).toBeGreaterThan(0);
    expect(
      renderer.mountedIds("content").every((id) => store.records.get(id)!.bounds.maxY <= 100),
    ).toBe(true);
    renderer.setViewport({ ...viewport, top: 100_000 });
    scheduler.runAll(400);
    expect(content.nodes).toHaveLength(0);
    expect(renderer.mountedCount).toBe(0);
  } finally {
    insert.mockRestore();
    build.mockRestore();
    get.mockRestore();
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

const PROMOTION_RECORDS = createViewportRectangleStore(10_000, () => 10).records;

it.each([383, 9_998])("bounds promotion reads at rank %s across a dense unmounted gap", (rank) => {
  const fixture = createPromotionFixture(rank);
  const { cache, content, dom, entry, instrumentation, mounted, pending, store, visibility } =
    fixture;
  const get = vi.spyOn(store, "get");
  const mountedGet = vi.spyOn(mounted, "get");
  const siblings = vi.spyOn(content, "childNodes", "get");
  const insert = vi.spyOn(content, "insertBefore");
  const stage = vi.fn(() => entry);
  try {
    const run: PendingMutationRun = {
      band: "content",
      capacity: 1,
      count: 0,
      entrants: [],
      entries: [],
      preserveRetainedOrder: true,
      successor: undefined,
    };
    const result = stagePromotedVisibility(entry.id, pending, new MountSlice(Infinity, () => 0), {
      detachedCache: cache,
      dom,
      instrumentation,
      mounted,
      orderDirty: { content: new Set(), highlight: new Set() },
      pathCache: new ScenePathCache(),
      store,
      visibility,
      waiting: () => false,
      stage,
      run: (_entry, successor) => {
        run.successor = successor;
        return run;
      },
    });
    expect(result).toEqual({ reason: "budget" });
    expect(stage).toHaveBeenCalledOnce();
    expect(
      publishStableEntrantRun(
        run,
        { dom, instrumentation, mounted, store, detachedCache: cache },
        0,
      ),
    ).toEqual([entry.id]);
    expect(fixture.visibleReads()).toBe(0);
    expect(get.mock.calls.length).toBeLessThanOrEqual(2);
    expect(mountedGet).not.toHaveBeenCalled();
    expect(siblings).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledExactlyOnceWith(firstPath(entry), firstPath(fixture.after));
    const expected = [
      ...fixture.connected.filter((item) => item.rank < rank),
      entry,
      ...fixture.connected.filter((item) => item.rank > rank),
    ];
    expect(content.nodes).toEqual(expected.map((item) => fakeNode(firstPath(item))));
  } finally {
    get.mockRestore();
    mountedGet.mockRestore();
    siblings.mockRestore();
    insert.mockRestore();
    cache.dispose();
    visibility.release();
    dom.release();
  }
  expect(cache.memoryUsage()).toBe(0);
  expect(dom.svg.parentNode).toBeNull();
});

function createPromotionFixture(rank: number) {
  const fixture = createDirectPublicationScene("path");
  const { content, dom, entry, instrumentation, store } = fixture;
  const records = new Map(PROMOTION_RECORDS);
  const target = records.get(`entry-${rank}`)!;
  const promoted = { ...target, id: entry.id, element: { ...target.element, id: entry.id } };
  records.delete(target.id);
  records.set(entry.id, promoted);
  store.records.clear();
  for (const [id, record] of records) store.records.set(id, record);
  entry.rank = rank;
  const cache = new DetachedSceneElementCache();
  const mounted = new Map<string, typeof entry>();
  for (const node of [...content.nodes]) node.remove();
  const connected = [...store.records.values()]
    .filter((record) => record.id !== entry.id && (record.rank < 384 || record.rank === 9_999))
    .sort((left, right) => left.rank - right.rank)
    .map((record) =>
      createMountedElement(
        dom.ownerDocument,
        record,
        buildElementPathParts(record.element),
        instrumentation,
      ),
    );
  for (const item of connected) {
    content.append(fakeNode(firstPath(item)));
    mounted.set(item.id, item);
    cache.registerMounted(item, store);
  }
  const visibility = new SceneVisibilityState(store, instrumentation);
  const result = visibility.query({ minX: 0, minY: 0, maxX: 100, maxY: 100 }).visibility;
  let reads = 0;
  const ids = new Proxy(result.content.ids, {
    get: (targetIds, key, receiver) => {
      if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
      return Reflect.get(targetIds, key, receiver) as unknown;
    },
  });
  const pending = {
    progressive: true,
    entrants: new Map(),
    visibility: { ...result, content: { ...result.content, ids } },
    runCount: 0,
  } as PendingReconciliation;
  return {
    ...fixture,
    cache,
    connected,
    mounted,
    pending,
    visibility,
    after: connected.find((item) => item.rank > rank)!,
    visibleReads: () => reads,
  };
}
