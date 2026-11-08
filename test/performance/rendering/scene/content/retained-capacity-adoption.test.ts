import { expect, it, vi, type Mock } from "vitest";
import type { ScenePathPreparation } from "../../../../../src/domain/geometry/prepared-scene-paths";
import { dirtyGeometryScene } from "../../../../fixtures/rendering/dirty-geometry-scene";
import { contentPaths } from "../../../../fixtures/rendering/selection-runs";
import {
  createTestStroke,
  createWorkerSnapshot,
} from "../../../../fixtures/persistence/worker-snapshot";
import { DocumentWorkerRuntime } from "../../../../../src/persistence/worker/runtime/public";
import { ProgressivePreviewPath } from "../../../../../src/rendering/scene/content/progressive-preview-path";
import { CommittedPreviewGeometry } from "../../../../../src/rendering/scene/presentation/committed-preview-geometry";
import {
  MAX_PREPARED_SCENE_PATH_IDS,
  MAX_PREPARED_SCENE_PATH_BYTES,
} from "../../../../../src/domain/geometry/prepared-scene-paths";
import { buildElementPathParts } from "../../../../../src/domain/geometry/element-path";
import { UniformSpatialIndex } from "../../../../../src/domain/spatial";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import {
  createSceneRecord,
  observeIndexedSceneQueries,
  sceneDeltaEntries,
} from "../../../../fixtures/rendering/scene";
import {
  asElement,
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  fakeNode,
} from "../../../../unit/rendering/scene/fakes";
import { SceneDom } from "../../../../../src/rendering/scene/scene-dom";
import { SceneVisibilityState } from "../../../../../src/rendering/scene/visibility/visibility-state";
import { SceneVisibilityReconciler } from "../../../../../src/rendering/scene/reconciliation/scene-visibility-reconciler";
import {
  createMountedElement,
  type MountedSceneElement,
} from "../../../../../src/rendering/scene/content/mounted-element";
import { createInstrumentation } from "../../../../../src/rendering/scene/instrumentation";
import { DetachedSceneElementCache } from "../../../../../src/rendering/scene/content/detached-element-cache";
import { DETACHED_ELEMENT_CACHE_MAX_BYTES } from "../../../../../src/rendering/scene/constants";
import { ScenePathCache } from "../../../../../src/rendering/scene/content/path-cache";
import type { SceneStorePort } from "../../../../../src/rendering/scene/types";
import { MountSlice } from "../../../../../src/rendering/scene/reconciliation/mount-slice";
import type { PendingReconciliation } from "../../../../../src/rendering/scene/reconciliation/reconciliation-state";
import {
  prepareVisibilityCleanup,
  removeOrderedVisibilityExits,
} from "../../../../../src/rendering/scene/reconciliation/visibility-reconciliation-commit";

it("parks dirty capacity contours during input while entrants, paint and culling remain responsive", async () => {
  let quiet: Promise<void> | undefined;
  let resume!: () => void;
  const scene = dirtyGeometryScene(10_000, 10_000, () => quiet);
  const paths = contentPaths(fakeNode(scene.renderer.svg));
  const content = new Set(paths);
  const write = vi.spyOn(FakeNode.prototype, "setAttribute");
  const build = vi.spyOn(ScenePathCache.prototype, "startPreparation");
  const contentWrites = () =>
    write.mock.calls.filter(([name], index) => {
      const node = write.mock.contexts[index];
      return name === "d" && node instanceof FakeNode && content.has(node);
    });
  scene.prepare.mockReturnValue(undefined);
  try {
    quiet = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const replacements = scene.replace();
    write.mockClear();
    scene.scheduler.runAll();
    expect(contentWrites()).toHaveLength(0);
    expect(build).not.toHaveBeenCalled();
    expect(scene.prepare).not.toHaveBeenCalled();
    expect(scene.scheduler.pendingCount).toBe(0);
    const first = replacements[0]!;
    if (first.kind !== "stroke") throw new Error("Expected a pressure stroke");
    const painted = { ...first, style: { ...first.style, opacity: 0.5 } };
    scene.renderer.applyDelta({
      affected: sceneDeltaEntries(scene.store.replace(painted.id, painted)!),
    });
    scene.scheduler.runAll();
    expect(paths[0]!.getAttribute("opacity")).toBe("0.5");
    const added = {
      ...createTestStroke(),
      id: "00000000-0000-4000-8000-000000900001",
      pivot: { x: 600, y: 10 },
      offset: { x: 590, y: 0 },
    };
    scene.renderer.applyDelta({ affected: sceneDeltaEntries(scene.store.create([added])!) });
    scene.renderer.setViewport({ left: 0, top: 0, width: 800, height: 100 });
    scene.scheduler.runAll();
    expect(scene.renderer.mountedCount).toBe(10_001);
    expect(build).toHaveBeenCalledOnce();
    expect(contentWrites()).toHaveLength(0);
    scene.renderer.setViewport({ left: 0, top: 0, width: 100, height: 100 });
    scene.scheduler.runAll();
    expect(scene.renderer.mountedCount).toBe(10_000);
    build.mockClear();
    scene.prepare.mockClear();
    write.mockClear();
    quiet = undefined;
    resume();
    await Promise.resolve();
    scene.scheduler.runFrame();
    // Observe actual canonical writes in the admitted frame, not a simulated latency.
    expect(contentWrites().length).toBeGreaterThan(1);
    scene.scheduler.runAll();
    expect(contentWrites()).toHaveLength(10_000);
    expect(build).toHaveBeenCalledTimes(10_000);
    expect(scene.prepare).toHaveBeenCalledTimes(10_000);
    expect(scene.requests).toHaveLength(0);
    expect(scene.scheduler.pendingCount).toBe(0);
    for (const rank of [0, 5000, 9999]) {
      const element = replacements[rank]!;
      expect(paths[rank]!.getAttribute("d")).toBe(buildElementPathParts(element)[0]!.d);
    }
  } finally {
    write.mockRestore();
    build.mockRestore();
    scene.dispose();
  }
  expect(scene.renderer.memoryUsage().pathCacheBytes).toBe(0);
});

it("publishes ten thousand current dirty mounted pressure contours from the existing bounded worker path pool", async () => {
  const scene = dirtyGeometryScene(10_000);
  const identity = {
    sessionId: "mounted-canonical",
    workerEpoch: 1,
    operationId: 1,
    purpose: "background" as const,
  };
  const worker = new DocumentWorkerRuntime(identity);
  const local = vi.spyOn(ProgressivePreviewPath.prototype, "step");
  const legacy = vi.spyOn(CommittedPreviewGeometry.prototype, "prepare");
  let operation = 1;
  let settle: Promise<unknown> | undefined;
  const sizes: number[] = [];
  const probes = new Set([
    scene.original[0]!.id,
    scene.original[5000]!.id,
    scene.original[9999]!.id,
  ]);
  const published = new Map<string, string>();
  let concurrent = 0;
  let maximumConcurrent = 0;
  const builds = scene.renderer.instrumentation().geometryBuilds;
  try {
    const replacements = scene.replace();
    await worker.execute({
      type: "model-sync-full",
      snapshot: createWorkerSnapshot(replacements, 1),
      modelRevision: 1,
      baseModelRevision: null,
      identity,
    });
    scene.port.prepareScenePaths = (ids, _signal, observer) => {
      sizes.push(ids.length);
      expect(ids.length).toBeLessThanOrEqual(MAX_PREPARED_SCENE_PATH_IDS);
      expect(observer!.maxBytes).toBeLessThanOrEqual(MAX_PREPARED_SCENE_PATH_BYTES);
      maximumConcurrent = Math.max(maximumConcurrent, ++concurrent);
      const pending = worker
        .execute({
          type: "prepare-scene-paths",
          basisRevision: 1,
          ids,
          identity: { ...identity, operationId: ++operation },
        })
        .then((result) => {
          concurrent -= 1;
          if (result.type !== "prepare-scene-paths-success")
            throw new Error("Worker contour preparation failed.");
          for (const { id, parts } of result.paths)
            if (probes.has(id)) published.set(id, parts[0]!.d);
          return result.paths;
        });
      settle = pending;
      return pending;
    };
    for (let round = 0; round < 200; round += 1) {
      scene.scheduler.runAll();
      const pending = settle;
      settle = undefined;
      if (pending === undefined) break;
      await pending;
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(sizes.reduce((total, size) => total + size, 0)).toBe(10_000);
    expect(sizes.length).toBeLessThanOrEqual(
      2 + Math.ceil((10_000 - MAX_PREPARED_SCENE_PATH_IDS) / (MAX_PREPARED_SCENE_PATH_IDS / 2)),
    );
    expect(maximumConcurrent).toBe(1);
    expect(worker.instrumentation.shapeBuilds).toBe(10_000);
    expect(scene.renderer.instrumentation().geometryBuilds).toBe(builds);
    expect(local).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
    expect(scene.renderer.mountedIds("content")).toHaveLength(10_000);
    const paths = contentPaths(fakeNode(scene.renderer.svg));
    expect(published.size).toBe(3);
    for (const id of probes)
      expect(paths[scene.port.get(id)!.rank]!.getAttribute("d")).toBe(published.get(id));
    expect(scene.scheduler.pendingCount).toBe(0);
    scene.dispose();
    expect(scene.renderer.memoryUsage().pathCacheBytes).toBe(0);
  } finally {
    local.mockRestore();
    legacy.mockRestore();
    worker.terminate();
    scene.dispose();
  }
});

it("coalesces worker retarget work across one real sixty-four-root exit slice", async () => {
  const scene = dirtyGeometryScene(MAX_PREPARED_SCENE_PATH_IDS);
  const invoke = scene.prepare.getMockImplementation()!;
  const retargets: Mock<(ids: readonly string[]) => void>[] = [];
  const cancelled = vi.fn();
  scene.prepare.mockImplementation((...args: Parameters<ScenePathPreparation>) => {
    const retarget = vi.fn<(ids: readonly string[]) => void>();
    retargets.push(retarget);
    args[2]?.setRetarget(retarget);
    args[1].addEventListener("abort", cancelled, { once: true });
    return invoke(...args);
  });
  try {
    scene.replace();
    scene.scheduler.runAll();
    scene.deliver(scene.requests[0]!);
    await Promise.resolve();
    await Promise.resolve();
    scene.scheduler.runAll();
    expect(scene.requests).toHaveLength(2);
    expect(scene.requests[1]!.ids).toHaveLength(MAX_PREPARED_SCENE_PATH_IDS - 1);
    const retarget = retargets[1]!;
    retarget.mockClear();
    const get = vi.spyOn(scene.port, "get");
    const before = scene.renderer.instrumentation().domExits;
    scene.renderer.setViewport({ left: 500, top: 500, width: 100, height: 100 });
    scene.scheduler.runFrame();
    expect(scene.renderer.instrumentation().domExits - before).toBe(64);
    const work = {
      retargets: retarget.mock.calls.length,
      transferredIds: retarget.mock.calls.reduce((total, [ids]) => total + ids.length, 0),
      reads: get.mock.calls.length,
    };
    expect(work.retargets, JSON.stringify(work)).toBe(1);
    expect(work.transferredIds).toBe(MAX_PREPARED_SCENE_PATH_IDS - 64);
    expect(work.reads).toBeLessThanOrEqual(MAX_PREPARED_SCENE_PATH_IDS * 4);
    expect(scene.requests[1]!.signal.aborted).toBe(false);
    expect(cancelled).not.toHaveBeenCalled();
    get.mockRestore();
    retarget.mockClear();
    scene.scheduler.runAll();
    expect(scene.requests[1]!.signal.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(scene.renderer.mountedCount).toBe(0);
    expect(retarget.mock.calls.length).toBeLessThanOrEqual(2);
  } finally {
    scene.dispose();
  }
});

function capacityScene() {
  const dom = new SceneDom(asElement(new FakeNode(new FakeDocument(), "div")), "Canvas", {});
  const store = new FakeSceneStore();
  const instrumentation = createInstrumentation();
  const mounted = new Map<string, MountedSceneElement>();
  const cache = new DetachedSceneElementCache();
  const probe = new DetachedSceneElementCache();
  const templates = [16, 256].map((samples) => {
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
  expect(DETACHED_ELEMENT_CACHE_MAX_BYTES).toBe(1024 * 1024);
  const incomingEntries: MountedSceneElement[] = [];
  for (let rank = 0; rank < 10_000; rank += 1) {
    const template = rank >= 9_998 ? large : small;
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
    if (rank >= 9_998) {
      fakeNode(dom.contentGroup).append(...entry.paths.map(({ node }) => fakeNode(node)));
      mounted.set(record.id, entry);
      cache.registerMounted(entry, store);
    } else {
      const bytes = template.bytes + 2 * (element.id.length - template.element.id.length);
      if (cache.statistics().bytes + bytes <= DETACHED_ELEMENT_CACHE_MAX_BYTES)
        expect(cache.retain(entry)).toBe(true);
      if (rank < 2) incomingEntries.push(entry);
    }
  }
  expect(DETACHED_ELEMENT_CACHE_MAX_BYTES - cache.statistics().bytes).toBeLessThan(
    small.bytes + 20,
  );
  expect(cache.retainedRoots).toBeLessThan(1_000);
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
  return {
    dom,
    store,
    cache,
    visibility,
    paths,
    reconciler,
    mounted,
    instrumentation,
    indexed,
    incoming: incomingEntries.flatMap((entry) => entry.paths.map(({ node }) => fakeNode(node))),
    incomingEntries,
  };
}

it("adopts incoming detached roots before exit retention can evict them at the 1 MiB limit", () => {
  const fixture = capacityScene();
  const { cache, dom, reconciler, mounted, instrumentation } = fixture;
  const content = fakeNode(dom.contentGroup);
  const outgoing = [...content.nodes];
  let clock = 0;
  const takeOriginal = cache.take.bind(cache);
  const restore = vi.spyOn(cache, "take").mockImplementation((record, stats) => {
    const entry = takeOriginal(record, stats);
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
    expect(restore).toHaveBeenCalledTimes(1);
    expect(fixture.incomingEntries).toContain(restore.mock.results[0]?.value);
    expect(fixture.incoming.every((node) => node.parentNode === null)).toBe(true);
    expect(outgoing.every((node) => node.parent === content)).toBe(true);
    expect(insert).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(mounted.size).toBe(2);
    expect(mounted.size).toBe(content.nodes.length);
    for (let rounds = 0; reconciler.hasPendingWork; rounds += 1) {
      expect(rounds).toBeLessThan(20);
      const publication = { remainingRoots: 192, remainingRemovals: 64 };
      reconciler.reconcile(20, () => clock, new Map(), new Map(), publication);
      expect(cache.statistics().bytes).toBeLessThanOrEqual(DETACHED_ELEMENT_CACHE_MAX_BYTES);
    }
    expect(remove).toHaveBeenCalledTimes(2);
    expect(outgoing.every((node) => node.parentNode === null)).toBe(true);
    expect(insert).toHaveBeenCalled();
    expect(content.nodes).toHaveLength(2);
    expect(content.nodes.every((node, index) => node === fixture.incoming[index])).toBe(true);
    expect(cache.statistics().evictions).toBeGreaterThan(0);
    expect(cache.retainedRoots).toBeLessThan(1_000);
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

it.each(["sort", "duplicates", "skipped"] as const)(
  "charges real %s cleanup progress before admitting another unit at the shared deadline",
  (progress) => {
    const count = 10_000;
    const mounted = new Map<string, MountedSceneElement>();
    for (let rank = 0; rank < count; rank += 1)
      mounted.set(`exit-${rank}`, {
        id: `exit-${rank}`,
        band: "content",
        committedRank: rank,
        detachedPathCount: 0,
      } as MountedSceneElement);
    let rawReads = 0;
    const ids =
      progress === "duplicates"
        ? Array<string>(count).fill("exit-0")
        : [...mounted.keys()].reverse();
    const pending = {
      exitIds: new Proxy(ids, {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/.test(key)) rawReads += 1;
          return Reflect.get(target, key, receiver) as unknown;
        },
      }),
      exitIndex: 0,
      exitScanComplete: true,
      exitOrderPrepared: progress === "skipped",
      cleanupFirst: true,
    } as PendingReconciliation;
    let clock = 0;
    const originalGet = mounted.get.bind(mounted);
    const read = vi.spyOn(mounted, "get").mockImplementation((id) => {
      clock = 8;
      return originalGet(id);
    });
    const now = () => clock;
    const slice = new MountSlice(8, now);
    const options = { mounted } as Parameters<typeof removeOrderedVisibilityExits>[1];
    try {
      expect(
        prepareVisibilityCleanup(pending, slice, {
          collect: () => undefined,
          remove: () => {
            expect(
              removeOrderedVisibilityExits(pending, options, {
                deadline: 8,
                now,
                isExit: () => false,
              }),
            ).toBe(false);
          },
        }),
      ).toBe("deadline");
      expect(slice.elements).toBe(1);
      expect(pending.exitIndex).toBe(progress === "skipped" ? 1 : 0);
      expect(pending.exitOrderPrepared).toBe(true);
      expect(pending.exitIds).toHaveLength(progress === "duplicates" ? 1 : count);
      expect(rawReads).toBe(progress === "skipped" ? 1 : count + 1);
      expect(read.mock.calls.length).toBeLessThanOrEqual(progress === "sort" ? count * 32 + 1 : 1);
    } finally {
      read.mockRestore();
    }
  },
);
