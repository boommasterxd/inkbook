import { expect, it, vi } from "vitest";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { UniformSpatialIndex } from "../../../../src/domain/spatial";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { createSceneRecord, observeIndexedSceneQueries } from "../../../fixtures/rendering/scene";
import {
  asElement,
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  fakeNode,
} from "../../../unit/rendering/scene/fakes";
import { SceneDom } from "../../../../src/rendering/scene/scene-dom";
import { SceneVisibilityState } from "../../../../src/rendering/scene/visibility-state";
import { SceneVisibilityReconciler } from "../../../../src/rendering/scene/scene-visibility-reconciler";
import {
  createMountedElement,
  type MountedSceneElement,
} from "../../../../src/rendering/scene/mounted-element";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { DetachedSceneElementCache } from "../../../../src/rendering/scene/detached-element-cache";
import { DETACHED_ELEMENT_CACHE_MAX_BYTES } from "../../../../src/rendering/scene/constants";
import { ScenePathCache } from "../../../../src/rendering/scene/path-cache";
import type { SceneStorePort } from "../../../../src/rendering/scene/types";

function capacityScene() {
  const dom = new SceneDom(asElement(new FakeNode(new FakeDocument(), "div")), "Canvas", {});
  const store = new FakeSceneStore();
  const instrumentation = createInstrumentation();
  const mounted = new Map<string, MountedSceneElement>();
  const cache = new DetachedSceneElementCache();
  const probe = new DetachedSceneElementCache();
  const templates = [16, 64].map((samples) => {
    const base = indexedStroke(0);
    const element = {
      ...base,
      pivot: { x: 20, y: 50 },
      points: Array.from({ length: samples }, (_, index) => [
        20 + index / 4,
        50 + Math.sin(index / 3),
        0.5,
      ]).flat(),
      style: { ...base.style, pressureEnabled: false },
    };
    const record = createSceneRecord(element);
    const parts = buildElementPathParts(element);
    const entry = createMountedElement(dom.ownerDocument, record, parts, instrumentation);
    probe.retain(entry);
    const bytes = probe.statistics().bytes;
    probe.release();
    return { element, parts, bytes };
  });
  const small = templates[0]!;
  const large = templates[1]!;
  expect(small.bytes * 9_998).toBeLessThan(DETACHED_ELEMENT_CACHE_MAX_BYTES);
  for (let rank = 0; rank < 10_000; rank += 1) {
    const remaining = Math.max(0, 9_997 - rank);
    const template =
      rank >= 9_998 ||
      cache.statistics().bytes + large.bytes + remaining * small.bytes <=
        DETACHED_ELEMENT_CACHE_MAX_BYTES
        ? large
        : small;
    const y = rank < 2 ? 50 : rank >= 9_998 ? 20_050 : 10_050;
    const element = {
      ...template.element,
      id: indexedStroke(rank).id,
      pivot: { x: 20, y },
      points: template.element.points.map((value, index) =>
        index % 3 === 1 ? value + y - 50 : value,
      ),
    };
    const record = createSceneRecord(element, rank);
    const entry = createMountedElement(dom.ownerDocument, record, template.parts, instrumentation);
    store.records.set(record.id, record);
    fakeNode(dom.contentGroup).append(...entry.paths.map(({ node }) => fakeNode(node)));
    if (rank >= 9_998) {
      mounted.set(record.id, entry);
      cache.registerMounted(entry, store);
    } else expect(cache.retainConnected(entry, store)).toBe(true);
  }
  expect(DETACHED_ELEMENT_CACHE_MAX_BYTES - cache.statistics().bytes).toBeLessThan(large.bytes);
  const index = new UniformSpatialIndex<string>();
  index.insertMany([...store.records.values()].map(({ id, bounds }) => ({ id, bounds })));
  const indexed = observeIndexedSceneQueries(index);
  const indexedStore: SceneStorePort = {
    get: (id) => store.get(id),
    beginQuery: (bounds) => index.beginQuery(bounds),
    query: () => {
      throw new Error("Visibility must use its indexed cursor.");
    },
  };
  const visibility = new SceneVisibilityState(indexedStore, instrumentation);
  visibility.query({ minX: 0, minY: 20_000, maxX: 100, maxY: 20_100 });
  const paths = new ScenePathCache();
  const reconciler = new SceneVisibilityReconciler({
    dom,
    instrumentation,
    mounted,
    orderDirty: { content: new Set(), highlight: new Set() },
    pathCache: paths,
    detachedCache: cache,
    store: indexedStore,
    visibility,
  });
  const target = visibility.query({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
  reconciler.replace(target.visibility, true, target.delta);
  return { dom, store, cache, visibility, paths, reconciler, mounted, instrumentation, indexed };
}

it("adopts incoming original roots before exit retention can evict them at the 25 MiB limit", () => {
  const fixture = capacityScene();
  const { cache, dom, reconciler, mounted, instrumentation } = fixture;
  const content = fakeNode(dom.contentGroup);
  const original = [...content.nodes];
  let clock = 0;
  const restoreOriginal = cache.restoreConnected.bind(cache);
  const restore = vi.spyOn(cache, "restoreConnected").mockImplementation((record) => {
    const entry = restoreOriginal(record);
    if (entry !== undefined && clock === 0) clock = 10;
    return entry;
  });
  const remove = vi.spyOn(FakeNode.prototype, "remove");
  const insert = vi.spyOn(content, "insertBefore");
  const membership = vi.spyOn(fixture.visibility, "contains");
  try {
    expect(
      reconciler.reconcile(10, () => clock, new Map(), new Map(), { remainingRoots: 192 }).pending,
    ).toBe(true);
    expect(mounted.size).toBe(3);
    for (let rounds = 0; reconciler.hasPendingWork || cache.hasPendingCleanup; rounds += 1) {
      expect(rounds).toBeLessThan(20);
      const publication = { remainingRoots: 192, remainingRemovals: 64 };
      cache.flushEvictions(20, () => clock, publication);
      reconciler.reconcile(20, () => clock, new Map(), new Map(), publication);
      expect(cache.statistics().bytes).toBeLessThanOrEqual(DETACHED_ELEMENT_CACHE_MAX_BYTES);
    }
    expect(remove).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(content.nodes).toHaveLength(10_000);
    expect(content.nodes.every((node, index) => node === original[index])).toBe(true);
    expect(cache.statistics().evictions).toBe(0);
    expect(cache.retainedRoots).toBe(9_998);
    expect(membership.mock.calls.length).toBeLessThanOrEqual(32);
    expect(mounted.size).toBe(2);
    expect(instrumentation.geometryBuilds).toBe(0);
    expect(fixture.indexed.work.indexedVisits).toBeLessThanOrEqual(32);
  } finally {
    restore.mockRestore();
    remove.mockRestore();
    insert.mockRestore();
    membership.mockRestore();
    reconciler.release();
    cache.dispose();
    fixture.paths.release();
    fixture.visibility.release();
    fixture.indexed.query.mockRestore();
    dom.release();
  }
  expect(cache.memoryUsage()).toBe(0);
});
