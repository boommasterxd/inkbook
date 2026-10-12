import { expect, it, vi } from "vitest";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { SceneFrameWork } from "../../../../src/rendering/scene/scene-frame-work";
import { SceneContentScheduler } from "../../../../src/rendering/scene/scene-content-scheduler";
import { removeOrderedVisibilityExits } from "../../../../src/rendering/scene/visibility-reconciliation-commit";
import { createSceneRecord, createViewportRectangleStore } from "../../../fixtures/rendering/scene";
import {
  createDirectPublicationScene,
  createPublicationScene,
  createPreparedPublicationScene,
  expectReleasedPublicationScene,
  observeCompletedMountPreparation,
  settlePreparedPublication,
  waitForPreparedMounts,
} from "../../../fixtures/rendering/scene-publication";
import { FakeNode, FakeSceneStore, fakeRectangleRecord } from "../../../unit/rendering/scene/fakes";
import { arrow } from "../../../unit/domain/schema/fixtures";

const INITIAL = { height: 100, left: 0, top: 0, width: 1_000 };
const TARGET = { ...INITIAL, top: 1_000 };

it.each(["budget", "deadline"])("defers a protected partial repair at the shared %s", (reason) => {
  const fixture = createDirectPublicationScene("multipart");
  const { entry, before, after, content, dom, instrumentation, store } = fixture;
  const roots = entry.paths.map(({ node }) => node);
  const afterRoot = content.nodes[1]!;
  for (const root of roots) content.insertBefore(root as unknown as FakeNode, afterRoot);
  roots[1]!.remove();
  entry.detachedPathCount = 1;
  const pending = {
    exitIds: reason === "deadline" ? ["stale", entry.id] : [entry.id],
    exitIndex: 0,
    exitScanComplete: true,
    exitOrderPrepared: true,
  };
  const publication = { remainingRoots: 1, remainingRemovals: 64 };
  const options = {
    dom,
    store,
    instrumentation,
    mounted: new Map([[entry.id, entry]]),
    visibility: { contains: () => false, releaseId: vi.fn() },
    pathCache: { invalidate: vi.fn(), retain: vi.fn() },
  };
  const insert = vi.spyOn(content, "insertBefore");
  try {
    expect(
      removeOrderedVisibilityExits(
        pending as Parameters<typeof removeOrderedVisibilityExits>[0],
        options,
        {
          deadline: 8,
          now: () => (reason === "deadline" ? 8 : 0),
          isExit: () => false,
          publication,
        },
      ),
    ).toBe(false);
    expect(pending.exitIndex).toBe(reason === "deadline" ? 1 : 0);
    expect(entry.detachedPathCount).toBe(1);
    expect(insert).not.toHaveBeenCalled();
    publication.remainingRoots = 2;
    expect(
      removeOrderedVisibilityExits(
        pending as Parameters<typeof removeOrderedVisibilityExits>[0],
        options,
        {
          deadline: 8,
          now: () => 0,
          isExit: () => false,
          publication,
        },
      ),
    ).toBe(true);
    expect(insert.mock.calls.map(([node]) => node)).toEqual([...roots].reverse());
    expect(content.nodes).toEqual([before.paths[0]!.node, ...roots, after.paths[0]!.node]);
    expect(entry.detachedPathCount).toBe(0);
    expect(publication).toEqual({ remainingRoots: 0, remainingRemovals: 64 });
    expect(instrumentation.domRootsPublished).toBe(2);
    expect(instrumentation.domFragmentRuns).toBe(insert.mock.calls.length);
    expect(options.mounted.get(entry.id)).toBe(entry);
  } finally {
    insert.mockRestore();
  }
});

it("repairs an offscreen multipart root when a transform preview protects its interrupted exit", () => {
  const store = createViewportRectangleStore(63, () => 20);
  const record = createSceneRecord(arrow(), 63);
  const next = fakeRectangleRecord("next", 64, 20, 10_000);
  for (const item of [record, next]) store.records.set(item.id, item);
  const viewport = { height: 500, left: 0, top: 0, width: 500 };
  const { renderer, scheduler, content } = createPublicationScene(store, viewport);
  renderer.setReducedMotion(true);
  const original = [...content.nodes];
  const roots = original.slice(-2);
  expect(original).toHaveLength(65);
  renderer.setViewport({ ...viewport, top: 10_000 });
  scheduler.runNext();
  expect(content.nodes).toHaveLength(2);
  expect(roots[1]!.parent).toBeUndefined();
  const nextRoot = content.nodes[1]!;
  const insert = vi.spyOn(content, "insertBefore");
  renderer.resetInstrumentation();
  try {
    renderer.setPreviewTransform([record.id], "translate(0 10000)", 1);
    scheduler.runAll();
    expect(insert.mock.calls.map(([node]) => node)).toEqual([...roots].reverse());
    expect(content.nodes).toEqual([...roots, nextRoot]);
    expect(roots.every((node) => node.attributes.get("transform") === "translate(0 10000)")).toBe(
      true,
    );
    expect(renderer.mountedIds("content")).toEqual([next.id]);
    expect(renderer.mountedCount).toBe(2);
    expect(renderer.instrumentation()).toMatchObject({
      domRootsPublished: 2,
      domFragmentRuns: insert.mock.calls.length,
      geometryBuilds: 0,
    });
    renderer.clearPreviewTransforms();
    scheduler.runAll();
    expect(content.nodes).toEqual([nextRoot]);
    expect(roots.every((node) => node.parent === undefined)).toBe(true);
    expect(renderer.mountedCount).toBe(1);
  } finally {
    insert.mockRestore();
    renderer.destroy();
  }
  expectReleasedPublicationScene(renderer, scheduler);
});

function originalPaths(band: FakeNode): string[] {
  return band.nodes
    .flatMap((node) => (node.tagName === "g" ? node.nodes : [node]))
    .map((node) => node.attributes.get("d")!);
}

it("inserts inside a retained rank gap and keeps original roots through reorder and revisit", () => {
  const store = new FakeSceneStore();
  const first = fakeRectangleRecord("first", 10, 20, 20);
  const last = fakeRectangleRecord("last", 30, 30, 20);
  const entrant = fakeRectangleRecord("entrant", 20, 40, 500);
  for (const record of [first, last, entrant]) store.records.set(record.id, record);
  const { renderer, scheduler, document, content } = createPublicationScene(store, INITIAL);
  const retained = [...content.nodes];
  renderer.setViewport({ ...INITIAL, height: 400 });
  scheduler.runAll();
  expect(content.nodes[0]).toBe(retained[0]);
  expect(content.nodes[2]).toBe(retained[1]);
  expect(originalPaths(content)).toEqual(
    [first, entrant, last].flatMap((record) =>
      buildElementPathParts(record.element).map((p) => p.d),
    ),
  );
  store.records.set(first.id, { ...first, rank: 40 });
  renderer.applyDelta({ affected: [{ id: first.id, domains: ["order"] }] });
  scheduler.runAll();
  expect(content.nodes[2]).toBe(retained[0]);
  const physical = [...content.nodes];
  renderer.setViewport(TARGET);
  scheduler.runAll();
  expect(content.nodes).toHaveLength(0);
  expect(physical.every((node) => node.parent === undefined)).toBe(true);
  renderer.resetInstrumentation();
  const fragments = vi.spyOn(document, "createDocumentFragment");
  renderer.setViewport({ ...INITIAL, height: 400 });
  scheduler.runAll();
  expect(content.nodes).toEqual(physical);
  expect(renderer.instrumentation()).toMatchObject({
    domEntrants: 3,
    domRootsPublished: 3,
    domReorders: 0,
    geometryBuilds: 0,
    detachedCacheHits: 3,
  });
  expect(fragments).toHaveBeenCalledOnce();
  fragments.mockRestore();
  renderer.destroy();
  expect(scheduler.pendingCount).toBe(0);
});

it.each(["resume", "retarget", "destroy"])(
  "keeps a prepared batch unpublished after admission expires, then %s",
  (action) => {
    const store = createViewportRectangleStore(20, () => 1_030);
    const { renderer, scheduler, content } = createPublicationScene(store, INITIAL);
    const preparation = observeCompletedMountPreparation(scheduler, 8);
    const { stage } = preparation;
    try {
      renderer.setViewport(TARGET);
      waitForPreparedMounts(scheduler, preparation, 8);
      expect(content.nodes).toHaveLength(0);
      expect(renderer.mountedCount).toBe(0);
      stage.mockRestore();
      settlePreparedPublication(renderer, scheduler, action, INITIAL);
      expect(renderer.mountedCount).toBe(action === "resume" ? 20 : 0);
      expect(content.nodes).toHaveLength(action === "resume" ? 20 : 0);
    } finally {
      stage.mockRestore();
      renderer.destroy();
    }
    expect(scheduler.pendingCount).toBe(0);
  },
);

it.each([false, true])(
  "spends the late prepared-unit grant after mounted-first work=%s",
  (mountedFirst) => {
    const store = createViewportRectangleStore(20, () => 1_030);
    const paint = fakeRectangleRecord("paint", 30, 20, 20);
    store.records.set(paint.id, paint);
    const { renderer, scheduler, content } = createPublicationScene(store, INITIAL);
    const insert = vi.spyOn(content, "insertBefore");
    const preparation = observeCompletedMountPreparation(scheduler, 16);
    const { stage } = preparation;
    try {
      renderer.setViewport({ ...INITIAL, height: 1_100 });
      waitForPreparedMounts(scheduler, preparation, 16);
      expect(insert).not.toHaveBeenCalled();
      stage.mockRestore();
      if (mountedFirst) {
        if (paint.element.kind !== "rectangle") throw new Error("Expected a rectangle.");
        store.records.set(paint.id, {
          ...paint,
          paintVersion: 2,
          element: { ...paint.element, style: { ...paint.element.style, outlineOpacity: 0.5 } },
        });
        renderer.applyDelta({ affected: [{ id: paint.id, domains: ["paint"] }] });
      }
      const now = vi.spyOn(scheduler, "now").mockImplementation(() => (scheduler.time += 8));
      scheduler.time = 32;
      scheduler.runNext();
      expect(insert.mock.calls.length).toBe(mountedFirst ? 0 : 1);
      expect(renderer.mountedCount).toBe(mountedFirst ? 1 : 16);
      if (mountedFirst) {
        expect(renderer.instrumentation().contentAttributeWrites).toBeGreaterThan(0);
        scheduler.runNext();
        expect(insert).toHaveBeenCalledOnce();
        expect(renderer.mountedCount).toBe(16);
      }
      now.mockRestore();
      scheduler.runAll();
      expect(renderer.mountedCount).toBe(21);
    } finally {
      stage.mockRestore();
      insert.mockRestore();
      renderer.destroy();
    }
    expect(scheduler.pendingCount).toBe(0);
  },
);

it("routes an active entry whose bookkeeping expires admission through the late lane", () => {
  const store = new FakeSceneStore();
  const record = fakeRectangleRecord("bookkeeping", 0, 20, 1_030);
  store.records.set(record.id, record);
  const { renderer, scheduler, insert, preparation } = createPreparedPublicationScene(
    store,
    INITIAL,
  );
  const { stage } = preparation;
  renderer.setViewport(TARGET);
  waitForPreparedMounts(scheduler, preparation);
  stage.mockRestore();
  expect(insert).not.toHaveBeenCalled();
  const lane = vi.spyOn(SceneFrameWork.prototype, "write");
  const now = vi.spyOn(scheduler, "now").mockImplementation(() => (scheduler.time += 2));
  scheduler.runNext();
  expect(lane).toHaveBeenCalledOnce();
  expect(insert).toHaveBeenCalledOnce();
  now.mockRestore();
  lane.mockRestore();
  scheduler.runAll();
  expect(renderer.mountedIds("content")).toEqual([record.id]);
  renderer.destroy();
});

it("consumes an empty late grant before preparing an overrun element", () => {
  const store = new FakeSceneStore();
  const record = fakeRectangleRecord("empty-late", 0, 20, 1_030);
  store.records.set(record.id, record);
  const { renderer, scheduler, insert, preparation } = createPreparedPublicationScene(
    store,
    INITIAL,
  );
  const { stage } = preparation;
  const originalWrite = Object.getOwnPropertyDescriptor(SceneContentScheduler.prototype, "write")!
    .value as SceneContentScheduler["write"];
  const write = vi.spyOn(SceneContentScheduler.prototype, "write").mockImplementation(function (
    this: SceneContentScheduler,
    deadline,
    transforms,
    elements,
  ) {
    return originalWrite.call(this, deadline, transforms, elements, true);
  });
  renderer.setViewport(TARGET);
  waitForPreparedMounts(scheduler, preparation);
  expect(insert).not.toHaveBeenCalled();
  expect(renderer.mountedCount).toBe(0);
  stage.mockRestore();
  scheduler.runNext();
  expect(insert).toHaveBeenCalledOnce();
  write.mockRestore();
  scheduler.runAll();
  renderer.destroy();
  expect(scheduler.pendingCount).toBe(0);
});
