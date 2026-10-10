import { expect, it } from "vitest";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { SceneDom } from "../../../../src/rendering/scene/scene-dom";
import { ScenePathCache } from "../../../../src/rendering/scene/path-cache";
import { SceneVisibilityState } from "../../../../src/rendering/scene/visibility-state";
import { SceneVisibilityReconciler } from "../../../../src/rendering/scene/scene-visibility-reconciler";
import { ElementStore } from "../../../../src/domain/store/public";
import {
  MAX_PREPARED_SCENE_PATH_BYTES,
  MAX_PREPARED_SCENE_PATH_IDS,
  preparedScenePathBytes,
} from "../../../../src/domain/geometry/prepared-scene-paths";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import { createTestStroke } from "../../../fixtures/persistence/worker-snapshot";
import { FakeDocument, FakeNode, asElement } from "../../../unit/rendering/scene/fakes";

it.each([false, true])(
  "batches three thousand immutable pressure entrants across shared deadline slices=%s",
  async (sliced) => {
    const elements = new ElementStore();
    const store = new ElementSceneStore(elements);
    let now = 0;
    const get = store.get.bind(store);
    store.get = (id) => {
      if (sliced) now += 1;
      return get(id);
    };
    const requestSizes: number[] = [];
    store.prepareScenePaths = async (ids, _signal, observer) => {
      requestSizes.push(ids.length);
      expect(observer!.maxBytes).toBeLessThanOrEqual(MAX_PREPARED_SCENE_PATH_BYTES);
      const paths = ids.map((id) => ({ id, parts: [{ d: "M0 0Z", paint: "fill" as const }] }));
      expect(
        paths.reduce((bytes, path) => bytes + preparedScenePathBytes(path.id, path.parts), 0),
      ).toBeLessThanOrEqual(observer!.maxBytes!);
      return paths;
    };
    const stats = createInstrumentation();
    const visibility = new SceneVisibilityState(store, stats);
    const document = new FakeDocument();
    const dom = new SceneDom(asElement(new FakeNode(document, "div")), "Canvas", {});
    const cache = new ScenePathCache();
    const reconciler = new SceneVisibilityReconciler({
      dom,
      instrumentation: stats,
      mounted: new Map(),
      orderDirty: { content: new Set(), highlight: new Set() },
      pathCache: cache,
      store,
      visibility,
    });
    const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    reconciler.setPriority({ viewport: bounds, direction: { x: 0, y: 1 } });
    const empty = visibility.query(bounds).visibility;
    reconciler.replace(empty, true);
    reconciler.reconcile(Infinity, () => 0, new Map(), new Map(), { remainingRoots: 256 });
    const ids = addPressureEntries(elements, store, 0, 3000);
    visibility.invalidateForChanges();
    const target = visibility.query(bounds).visibility;
    reconciler.replace(target, true, { entered: ids, exited: [] });
    await drainReconciler(reconciler, sliced, () => now);
    // The singleton and initial lookahead fill the pool; further refills use at least half.
    const minimumRefill = MAX_PREPARED_SCENE_PATH_IDS / 2;
    const maximumRequests =
      2 + Math.ceil((ids.length - MAX_PREPARED_SCENE_PATH_IDS) / minimumRefill);
    expect(requestSizes[0]).toBe(1);
    expect(requestSizes[1]).toBeGreaterThanOrEqual(MAX_PREPARED_SCENE_PATH_IDS - 1);
    expect(requestSizes.slice(1, -1).every((size) => size >= minimumRefill)).toBe(true);
    expect(requestSizes.length).toBeLessThanOrEqual(maximumRequests);
    expect(requestSizes.every((size) => size <= MAX_PREPARED_SCENE_PATH_IDS)).toBe(true);
    expect(requestSizes.reduce((total, size) => total + size, 0)).toBe(3000);
    expect(stats.geometryBuilds).toBe(0);
    expect(dom.contentGroup.childNodes.length).toBe(3000);
    const requestCount = requestSizes.length;
    const added = addPressureEntries(elements, store, 3000, 4);
    visibility.invalidateForChanges();
    reconciler.replace(visibility.query(bounds).visibility, true, { entered: added, exited: [] });
    await drainReconciler(reconciler, sliced, () => now);
    expect(requestSizes.slice(requestCount)).toEqual([1, 3]);
    expect(dom.contentGroup.childNodes.length).toBe(3004);
    reconciler.release();
    expect(reconciler.memoryUsage()).toBe(0);
    visibility.release();
    cache.release();
    dom.release();
    store.release();
    elements.releasePreparedPressureGeometry();
  },
);

function addPressureEntries(
  elements: ElementStore,
  store: ElementSceneStore,
  start: number,
  count: number,
) {
  return Array.from({ length: count }, (_, index) => {
    const element = {
      ...createTestStroke(),
      id: `00000000-0000-4000-8000-${String(start + index).padStart(12, "0")}`,
    };
    elements.create([element]);
    const retained = store.get(element.id)!.element;
    if (retained.kind !== "stroke") throw new Error("Expected a stroke fixture.");
    expect(Object.isFrozen(retained.points)).toBe(true);
    return element.id;
  });
}

async function drainReconciler(
  reconciler: SceneVisibilityReconciler,
  sliced: boolean,
  now: () => number,
) {
  let rounds = 0;
  while (reconciler.hasPendingWork) {
    if (++rounds > 10_000) throw new Error("Delta preparation failed to settle.");
    reconciler.reconcile(sliced ? now() + 16 : Infinity, now, new Map(), new Map(), {
      remainingRoots: 256,
    });
    await Promise.resolve();
  }
}
