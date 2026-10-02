import { expect, it } from "vitest";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { SceneDom } from "../../../../src/rendering/scene/scene-dom";
import { ScenePathCache } from "../../../../src/rendering/scene/path-cache";
import { SceneVisibilityState } from "../../../../src/rendering/scene/visibility-state";
import { SceneVisibilityReconciler } from "../../../../src/rendering/scene/scene-visibility-reconciler";
import type { SceneStorePort } from "../../../../src/rendering/scene/types";
import { createTestStroke } from "../../../fixtures/persistence/worker-snapshot";
import { createSceneRecord } from "../../../fixtures/rendering/scene";
import {
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  asElement,
} from "../../../unit/rendering/scene/fakes";

it("batches the actual ascending visibility-delta entrants and avoids local contour work", async () => {
  const fake = new FakeSceneStore();
  let requests = 0;
  const store: SceneStorePort = {
    get: (id) => fake.get(id),
    query: (bounds, sink) => fake.query(bounds, sink),
    prepareScenePaths: async (ids) => {
      requests++;
      return ids.map((id) => ({ id, parts: [{ d: "M0 0Z", paint: "fill" }] }));
    },
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
  const empty = visibility.query(bounds).visibility;
  reconciler.replace(empty, true);
  reconciler.reconcile(Infinity, () => 0, new Map(), new Map(), { remainingRoots: 256 });
  const ids = Array.from({ length: 300 }, (_, index) => {
    const element = { ...createTestStroke(), id: `stroke-${index}` };
    fake.records.set(element.id, createSceneRecord(element, index));
    return element.id;
  });
  visibility.invalidateForChanges();
  const target = visibility.query(bounds).visibility;
  reconciler.replace(target, true, { entered: ids, exited: [] });
  let rounds = 0;
  while (reconciler.hasPendingWork) {
    if (++rounds > 100) throw new Error("Delta preparation failed to settle.");
    reconciler.reconcile(Infinity, () => 0, new Map(), new Map(), { remainingRoots: 256 });
    await Promise.resolve();
  }
  expect(requests).toBe(2);
  expect(stats.geometryBuilds).toBe(0);
  expect(dom.contentGroup.childNodes.length).toBe(300);
  reconciler.release();
  visibility.release();
  cache.release();
  dom.release();
});
