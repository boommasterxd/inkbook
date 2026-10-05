import { expect, it, vi } from "vitest";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { SceneFrameWork } from "../../../../src/rendering/scene/scene-frame-work";
import { SceneContentScheduler } from "../../../../src/rendering/scene/scene-content-scheduler";
import { createViewportRectangleStore } from "../../../fixtures/rendering/scene";
import {
  createPublicationScene,
  createPreparedPublicationScene,
  observeCompletedMountPreparation,
  settlePreparedPublication,
  waitForPreparedMounts,
} from "../../../fixtures/rendering/scene-publication";
import { FakeNode, FakeSceneStore, fakeRectangleRecord } from "../../../unit/rendering/scene/fakes";

const INITIAL = { height: 100, left: 0, top: 0, width: 1_000 };
const TARGET = { ...INITIAL, top: 1_000 };

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
  renderer.resetInstrumentation();
  const fragments = vi.spyOn(document, "createDocumentFragment");
  renderer.setViewport({ ...INITIAL, height: 400 });
  scheduler.runAll();
  expect(content.nodes).toEqual(physical);
  expect(renderer.instrumentation()).toMatchObject({ domEntrants: 0, domReorders: 0 });
  expect(fragments).not.toHaveBeenCalled();
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
