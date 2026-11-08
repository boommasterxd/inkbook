import { afterEach, expect, it, vi } from "vitest";
import {
  dirtyGeometryScene,
  drainDirtyGeometry,
  beginDirtyGeometryRun,
} from "../../../../fixtures/rendering/dirty-geometry-scene";
import { ProgressivePreviewPath } from "../../../../../src/rendering/scene/content/progressive-preview-path";
import { CommittedPreviewGeometry } from "../../../../../src/rendering/scene/presentation/committed-preview-geometry";
import { sceneDeltaEntries } from "../../../../fixtures/rendering/scene";
import { armSelectionCommit, contentPaths } from "../../../../fixtures/rendering/selection-runs";
import { buildElementPathParts } from "../../../../../src/domain/geometry/element-path";
import { SceneMountPreparation } from "../../../../../src/rendering/scene/reconciliation/scene-mount-preparation";
import { CanonicalElementPathPreparation } from "../../../../../src/domain/geometry/canonical-element-path-preparation";
import { roundCanonical } from "../../../../../src/domain/geometry/primitives";
import { createInstrumentation } from "../../../../../src/rendering/scene/instrumentation";
import { SceneDom } from "../../../../../src/rendering/scene/scene-dom";
import { ScenePathCache } from "../../../../../src/rendering/scene/content/path-cache";
import { SceneVisibilityState } from "../../../../../src/rendering/scene/visibility/visibility-state";
import { SceneVisibilityReconciler } from "../../../../../src/rendering/scene/reconciliation/scene-visibility-reconciler";
import { ElementStore } from "../../../../../src/domain/store/public";
import {
  MAX_PREPARED_SCENE_PATH_BYTES,
  MAX_PREPARED_SCENE_PATH_IDS,
  preparedScenePathBytes,
} from "../../../../../src/domain/geometry/prepared-scene-paths";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import { createTestStroke } from "../../../../fixtures/persistence/worker-snapshot";
import {
  FakeDocument,
  FakeNode,
  asElement,
  fakeNode,
} from "../../../../unit/rendering/scene/fakes";

afterEach(() => vi.restoreAllMocks());

it("keeps selection and paint work responsive while current mounted contours wait without polling frames", async () => {
  const scene = dirtyGeometryScene(3);
  try {
    scene.replace();
    const id = scene.original[0]!.id;
    scene.renderer.setSelectedElements(new Set([id]));
    const live = scene.port.get(scene.original[1]!.id)!.element;
    if (live.kind !== "stroke") throw new Error("Expected pressure ink.");
    const paint = {
      ...live,
      style: { ...live.style, color: { type: "rgba" as const, value: "#AABBCCFF" as const } },
    };
    scene.renderer.applyDelta({
      affected: sceneDeltaEntries(scene.store.replace(live.id, paint)!),
    });
    scene.scheduler.runAll();
    expect(scene.prepare).toHaveBeenCalledOnce();
    expect(scene.scheduler.pendingCount).toBe(0);
    expect(scene.renderer.mountedIds("content")).toHaveLength(3);
    expect(scene.renderer.instrumentation().selectionTraceNodesCreated).toBe(1);
    expect(
      contentPaths(fakeNode(scene.renderer.svg)).some(
        (node) => node.getAttribute("fill") === "#AABBCCFF",
      ),
    ).toBe(true);
    await drainDirtyGeometry(scene);
    expect(scene.prepare.mock.calls.flatMap(([ids]) => ids)).toHaveLength(3);
    expect(scene.scheduler.pendingCount).toBe(0);
  } finally {
    scene.dispose();
  }
});

it("cancels a stale mounted version and never publishes its late worker contours", async () => {
  const scene = dirtyGeometryScene();
  const local = vi.spyOn(ProgressivePreviewPath.prototype, "step");
  const legacy = vi.spyOn(CommittedPreviewGeometry.prototype, "prepare");
  try {
    const before = contentPaths(fakeNode(scene.renderer.svg))[0]!.getAttribute("d");
    scene.replace(2);
    scene.scheduler.runAll();
    const stale = scene.requests[0]!;
    scene.replace(3);
    scene.scheduler.runAll();
    expect(stale.signal.aborted).toBe(true);
    expect(scene.requests.length).toBe(2);
    scene.deliver(stale);
    await Promise.resolve();
    expect(contentPaths(fakeNode(scene.renderer.svg))[0]!.getAttribute("d")).toBe(before);
    expect(scene.scheduler.pendingCount).toBe(0);
    const delivered = scene.deliver(scene.requests[1]!);
    await Promise.resolve();
    await Promise.resolve();
    scene.scheduler.runAll();
    expect(contentPaths(fakeNode(scene.renderer.svg))[0]!.getAttribute("d")).toBe(
      delivered[0]!.parts[0]!.d,
    );
    expect(local).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
    expect(scene.scheduler.pendingCount).toBe(0);
  } finally {
    scene.dispose();
  }
});

it("normalizes an older SelectionRun target locally while worker requests use only live versions", async () => {
  const scene = dirtyGeometryScene(600, 0);
  const legacy = vi.spyOn(CommittedPreviewGeometry.prototype, "prepare");
  try {
    beginDirtyGeometryRun(scene);
    scene.replace(2);
    scene.scheduler.runFrame();
    const first = scene.requests[0]!;
    expect(first).toBeDefined();
    scene.replace(3);
    await drainDirtyGeometry(scene);
    expect(first.signal.aborted).toBe(true);
    expect(
      legacy.mock.calls.some(
        ([record]) => record.geometryVersion < scene.port.get(record.id)!.geometryVersion,
      ),
    ).toBe(true);
    expect(
      scene.requests
        .slice(1)
        .every((request) =>
          request.records.every(
            (record) => record.geometryVersion === scene.port.get(record.id)!.geometryVersion,
          ),
        ),
    ).toBe(true);
    expect(scene.scheduler.pendingCount).toBe(0);
  } finally {
    scene.dispose();
  }
});

it.each(["complete", "dispose"])(
  "sleeps during deferred visibility when a grouped commit waits for worker paths; %s",
  async (action) => {
    const scene = dirtyGeometryScene(600, 0);
    try {
      beginDirtyGeometryRun(scene);
      scene.replace();
      scene.scheduler.runFrame();
      const request = scene.requests[0]!;
      const added = { ...createTestStroke(), id: "00000000-0000-4000-8000-000000900001" };
      scene.renderer.applyDelta({ affected: sceneDeltaEntries(scene.store.create([added])!) });
      scene.scheduler.runAll();
      expect(scene.scheduler.pendingCount).toBe(0);
      if (action === "dispose") {
        scene.dispose();
        expect(request.signal.aborted).toBe(true);
        scene.deliver(request);
        await Promise.resolve();
      } else {
        await drainDirtyGeometry(scene);
        expect(scene.renderer.mountedIds("content")).toHaveLength(601);
      }
      expect(scene.scheduler.pendingCount).toBe(0);
    } finally {
      scene.dispose();
    }
  },
);

it("finishes a partially built local scratch when another owner publishes its contour, then admits a cold entrant", async () => {
  const scene = dirtyGeometryScene();
  const id = scene.original[0]!.id;
  const prepare = vi.spyOn(SceneMountPreparation.prototype, "prepare");
  try {
    const replacement = {
      ...scene.original[0]!,
      points: Array.from({ length: 4096 }, (_, index) => [
        roundCanonical(10 + index / 1024),
        roundCanonical(10 + Math.sin(index / 100)),
        0.5,
      ]).flat(),
    };
    armSelectionCommit({ renderer: scene.renderer, ids: [id] });
    scene.renderer.applyDelta({
      affected: sceneDeltaEntries(scene.store.replace(id, replacement)!),
    });
    scene.scheduler.runAll();
    scene.requests[0]!.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    const step = Object.getOwnPropertyDescriptor(CanonicalElementPathPreparation.prototype, "step")!
      .value as ProgressivePreviewPath["step"];
    const observed = vi
      .spyOn(ProgressivePreviewPath.prototype, "step")
      .mockImplementation(function (this: ProgressivePreviewPath, ...args) {
        const done = step.apply(this, args);
        scene.scheduler.time += 20;
        return done;
      });
    scene.scheduler.runFrame();
    observed.mockRestore();
    const preparation = prepare.mock.contexts.find(
      (context) => context instanceof SceneMountPreparation && context.pendingId === id,
    );
    if (!(preparation instanceof SceneMountPreparation))
      throw new Error("Expected an owned pending pressure scratch.");
    const record = scene.port.get(id)!;
    scene.port.pressureGeometry(id, record.geometryVersion).publishPath!(
      buildElementPathParts(record.element),
    );
    scene.scheduler.runAll();
    expect(preparation.pendingId).toBeUndefined();
    scene.port.prepareScenePaths = undefined;
    const added = { ...createTestStroke(), id: "00000000-0000-4000-8000-000000900001" };
    scene.renderer.applyDelta({ affected: sceneDeltaEntries(scene.store.create([added])!) });
    scene.scheduler.runAll();
    expect(scene.renderer.mountedIds("content")).toHaveLength(2);
    expect(scene.scheduler.pendingCount).toBe(0);
  } finally {
    scene.dispose();
  }
});

it.each(["undefined", "failure"])(
  "retains local fallback and retries subsequent canonical ink after a %s response",
  async (response) => {
    const scene = dirtyGeometryScene(2);
    const local = vi.spyOn(ProgressivePreviewPath.prototype, "step");
    try {
      scene.replace();
      scene.scheduler.runAll();
      if (response === "failure") scene.requests[0]!.reject(new Error("Worker unavailable."));
      else scene.requests[0]!.resolve(undefined);
      await Promise.resolve();
      await Promise.resolve();
      scene.scheduler.runAll();
      expect(local).toHaveBeenCalled();
      expect(scene.requests.length).toBe(2);
      scene.deliver(scene.requests[1]!);
      await Promise.resolve();
      await Promise.resolve();
      scene.scheduler.runAll();
      expect(scene.scheduler.pendingCount).toBe(0);
    } finally {
      scene.dispose();
    }
  },
);

it.each(["unmount", "destroy"])(
  "releases delayed mounted contour ownership on %s before progress",
  async (action) => {
    const scene = dirtyGeometryScene();
    try {
      scene.replace();
      scene.scheduler.runAll();
      const request = scene.requests[0]!;
      if (action === "destroy") scene.renderer.destroy();
      else {
        scene.renderer.setViewport({ left: 500, top: 500, width: 100, height: 100 });
        scene.scheduler.runAll();
        expect(scene.renderer.mountedIds("content")).toHaveLength(0);
      }
      expect(request.signal.aborted).toBe(true);
      scene.deliver(request);
      await Promise.resolve();
      expect(scene.scheduler.pendingCount).toBe(0);
    } finally {
      scene.dispose();
    }
  },
);

it("shares the bounded contour pool between mounted updates and competing visibility entrants", async () => {
  const scene = dirtyGeometryScene(300);
  try {
    scene.replace();
    scene.scheduler.runAll();
    const added = { ...createTestStroke(), id: "00000000-0000-4000-8000-000000900001" };
    scene.renderer.applyDelta({ affected: sceneDeltaEntries(scene.store.create([added])!) });
    await drainDirtyGeometry(scene);
    const ids = scene.prepare.mock.calls.flatMap(([requested]) => requested);
    expect(new Set(ids).size).toBe(301);
    expect(ids).toHaveLength(301);
    expect(
      scene.prepare.mock.calls.every(
        ([requested]) => requested.length <= MAX_PREPARED_SCENE_PATH_IDS,
      ),
    ).toBe(true);
    expect(
      scene.requests.every(
        (request) => request.options!.maxBytes! <= MAX_PREPARED_SCENE_PATH_BYTES,
      ),
    ).toBe(true);
    expect(scene.renderer.mountedIds("content")).toHaveLength(301);
    expect(scene.scheduler.pendingCount).toBe(0);
  } finally {
    scene.dispose();
  }
});

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
