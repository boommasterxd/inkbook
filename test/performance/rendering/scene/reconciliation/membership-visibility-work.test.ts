import { expect, it, vi } from "vitest";
import {
  createIndexedSceneStore,
  createSceneFixture,
  createViewportRectangleStore,
  replaySceneMembership,
} from "../../../../fixtures/rendering/scene";
import { NAVIGATION_PAGE } from "../../../../fixtures/rendering/pressure-navigation";
import { createTestStroke } from "../../../../fixtures/persistence/worker-snapshot";
import {
  FakeDocument,
  FakeAnimation,
  FakeNode,
  fakeNode,
  fakeRectangleRecord,
} from "../../../../unit/rendering/scene/fakes";
import { createMountedElement } from "../../../../../src/rendering/scene/content/mounted-element";
import { createInstrumentation } from "../../../../../src/rendering/scene/instrumentation";
import { SceneElementFades } from "../../../../../src/rendering/scene/presentation/scene-element-fades";
import { VisibilityClassification } from "../../../../../src/rendering/scene/visibility/visibility-classification";
import { SceneVisibilityState } from "../../../../../src/rendering/scene/visibility/visibility-state";
import { activeFades } from "../../../../fixtures/rendering/scene-fades";

const VISIBLE_COUNT = 64;

function expectSceneReleased(scene: ReturnType<typeof createSceneFixture>): void {
  expect(scene.scheduler.pendingCount).toBe(0);
  expect(scene.renderer.memoryUsage()).toEqual({ pathCacheBytes: 0, motionCacheBytes: 0 });
}

it("removes from 10,000 fully published roots without another candidate classification", () => {
  const store = createViewportRectangleStore(10_000, () => 10);
  const scene = createSceneFixture(NAVIGATION_PAGE, store);
  const { renderer, scheduler, document } = scene;
  renderer.setReducedMotion(true);
  scheduler.runAll(200);
  const visibleCount = renderer.mountedCount;
  expect(visibleCount).toBe(10_000);
  const removed = [...store.records.values()].slice(0, 10);
  renderer.resetInstrumentation();
  const classification = vi.spyOn(VisibilityClassification.prototype, "collect");
  const creation = vi.spyOn(document, "createElementNS");
  const get = vi.spyOn(store, "get");
  const contains = vi.spyOn(SceneVisibilityState.prototype, "contains");
  // eslint-disable-next-line @typescript-eslint/unbound-method -- The wrapper forwards the actual receiver through apply.
  const queryVisibility = SceneVisibilityState.prototype.query;
  const query = vi.spyOn(SceneVisibilityState.prototype, "query");
  query.mockImplementation(function (this: SceneVisibilityState, ...args) {
    const reads = get.mock.calls.length;
    const visits = contains.mock.calls.length;
    const result = queryVisibility.apply(this, args);
    expect(get.mock.calls.length - reads).toBe(0);
    expect(contains.mock.calls.length - visits).toBeLessThanOrEqual(visibleCount);
    return result;
  });
  try {
    for (const record of removed) store.records.delete(record.id);
    renderer.applyDelta({
      affected: removed.map((record) => ({
        id: record.id,
        before: record.element,
        after: null,
        beforeBounds: record.bounds,
        afterBounds: null,
        domains: ["order", "visibility"],
      })),
    });
    scheduler.runAll(200);
    expect(renderer.mountedCount).toBe(9_990);
    expect(renderer.instrumentation()).toMatchObject({
      spatialQueries: 0,
      visibilityCandidateVisits: 0,
      domReorders: 0,
    });
    expect(classification).not.toHaveBeenCalled();
    expect(creation).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledOnce();
    expect(get.mock.calls.length).toBeLessThanOrEqual(removed.length * 8);
  } finally {
    for (const observation of [classification, creation, get, contains, query])
      observation.mockRestore();
    renderer.destroy();
  }
  expectSceneReleased(scene);
});

it("admits visible stroke paint before a 10,000-stroke offscreen reserve without scanning it", () => {
  const document = new FakeDocument();
  const stroke = createTestStroke();
  const entries = Array.from({ length: 10_000 }, (_, rank) => {
    const id = `stroke-${String(rank)}`;
    const record = {
      ...fakeRectangleRecord(id, rank, 10, rank < VISIBLE_COUNT ? 10 : 1_100),
      element: { ...stroke, id, style: { ...stroke.style, opacity: 0.35, pressureEnabled: false } },
    };
    return {
      bounds: record.bounds,
      entry: createMountedElement(
        document as unknown as Document,
        record,
        [{ d: "M0 0L10 10", paint: "stroke" }],
        createInstrumentation(),
      ),
    };
  });
  const mounted = new Map(entries.map(({ entry }) => [entry.id, entry]));
  const fades = new SceneElementFades(mounted);
  fades.setViewport({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
  for (const { entry, bounds } of [...entries].reverse())
    fades.setMembership(entry.id, "exit", 150, bounds);
  const observed = observeFadeWrites(
    document,
    entries.map(({ entry }) => fakeNode(entry.paths[0]!.node)),
  );
  const get = vi.spyOn(mounted, "get");
  try {
    fades.flush(Infinity, () => 0);
    expect(observed.work.starts).toBe(VISIBLE_COUNT);
    expect(observed.work.writes).toBeLessThanOrEqual(128);
    // One lookup per admitted element, independent of the 10,000 queued records.
    expect(get.mock.calls.length).toBeLessThanOrEqual(128);
    const visible = entries.slice(0, VISIBLE_COUNT);
    expect(visible.every(({ entry }) => activeFades(entry.paths[0]!.node).length === 1)).toBe(true);
    expect(
      visible.every(
        ({ entry }) => fakeNode(entry.paths[0]!.node).attributes.get("stroke-opacity") === "0.35",
      ),
    ).toBe(true);
    expect(visible.every(({ entry }) => !fades.isExitReady(entry.id, 149))).toBe(true);
    expect(visible.every(({ entry }) => fades.isExitReady(entry.id, 150))).toBe(true);
    fades.interruptMembership();
    fades.set(
      entries.map(({ entry }) => entry.id),
      null,
    );
    expect(fades.pending).toBe(false);
    expect(fades.memoryUsage()).toBe(0);
    const writes = observed.work.writes;
    fades.flush(Infinity, () => 150);
    expect(observed.work.writes).toBe(writes);
  } finally {
    get.mockRestore();
    observed.restore();
    fades.release();
  }
});

it.each([1_000, 10_000])(
  "bounds actual history animation starts and style writes with %i retained roots",
  (count) => {
    const records = createViewportRectangleStore(count, (rank) =>
      rank < VISIBLE_COUNT ? 10 : 1_100,
    );
    const indexed = createIndexedSceneStore(records);
    const scene = createSceneFixture(NAVIGATION_PAGE, indexed.store, undefined, {
      scrollPreloadMarginPx: 800,
    });
    const { document, renderer, scheduler } = scene;
    scheduler.runAll(200);
    expect(renderer.mountedCount).toBe(count);
    const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
    // Commit the offscreen reserve before the visible tail, independently of paint rank.
    const entries = [...records.records.values()].reverse();
    const observed = observeFadeWrites(document, content.nodes);
    const commits = vi.spyOn(FakeAnimation.prototype, "commitStyles");
    const remove = vi.spyOn(FakeNode.prototype, "remove");
    const replay = (exit: boolean) => {
      replaySceneMembership(renderer, records, entries, exit ? "exit" : "enter");
    };
    const frame = () => {
      const removals = remove.mock.calls.length;
      const writes = observed.work.writes;
      const paints = commits.mock.calls.length;
      scheduler.runNext();
      expect(commits.mock.calls.length - paints).toBeLessThanOrEqual(VISIBLE_COUNT);
      expect(remove.mock.calls.length - removals).toBeLessThanOrEqual(64);
      expect(observed.work.writes - writes).toBeLessThanOrEqual(256 + VISIBLE_COUNT);
    };
    const drainCleanup = () => {
      let remainingFrames = 200;
      while (scheduler.pendingCount > 0) {
        expect(remainingFrames--).toBeGreaterThan(0);
        frame();
      }
      expect(renderer.mountedCount).toBe(0);
    };
    try {
      replay(true);
      expect(observed.work.writes).toBe(0);
      frame();
      expect(observed.work.starts).toBe(VISIBLE_COUNT);
      expect(observed.work.writes).toBeLessThanOrEqual(128);
      replay(false);
      frame();
      expect(commits).toHaveBeenCalledTimes(VISIBLE_COUNT);
      expect(observed.work.starts).toBe(VISIBLE_COUNT * 2);
      expect(observed.work.writes).toBeLessThanOrEqual(128 + VISIBLE_COUNT);
      replay(true);
      frame();
      expect(commits).toHaveBeenCalledTimes(VISIBLE_COUNT * 2);
      expect(observed.work.starts).toBe(VISIBLE_COUNT * 3);
      expect(observed.work.writes).toBeLessThanOrEqual(256 + VISIBLE_COUNT);
      scheduler.time = 400;
      drainCleanup();
      expect(observed.work.starts).toBe(VISIBLE_COUNT * 3);
      expect(indexed.fallback).not.toHaveBeenCalled();
      replay(false);
      frame();
      for (let frames = 0; renderer.mountedCount < count; frames += 1) {
        expect(frames).toBeLessThan(100);
        frame();
      }
      expect(observed.work.starts).toBe(VISIBLE_COUNT * 4);
      // Each offscreen exit receives one instantaneous concealment; entrances need none.
      expect(observed.work.writes).toBeLessThanOrEqual(count + VISIBLE_COUNT * 6);
      expect(content.nodes.filter((node) => activeFades(node).length > 0)).toHaveLength(
        VISIBLE_COUNT,
      );
      scheduler.time = 800;
      while (scheduler.pendingCount > 0) frame();
      expect(observed.work.writes).toBeLessThanOrEqual(count + VISIBLE_COUNT * 7);
      expect(
        content.nodes.every((node) => activeFades(node).length === 0 && !node.style.visibility),
      ).toBe(true);
      expect(renderer.instrumentation()).toMatchObject({ motionTombstones: 0, motionEntrances: 0 });
    } finally {
      observed.restore();
      commits.mockRestore();
      remove.mockRestore();
      renderer.destroy();
    }
    expectSceneReleased(scene);
  },
);

function observeFadeWrites(document: FakeDocument, roots: readonly FakeNode[]) {
  const work = { writes: 0, starts: 0 };
  const watched = new WeakSet<FakeNode>();
  const animations: Array<{ mockRestore: () => void }> = [];
  const observe = (node: FakeNode) => {
    if (watched.has(node)) return;
    watched.add(node);
    Object.defineProperty(node, "isConnected", { get: () => node.parent !== undefined });
    const start = node.animate.bind(node);
    animations.push(
      vi.spyOn(node, "animate").mockImplementation((...args) => {
        work.starts += 1;
        return start(...args);
      }),
    );
    for (const property of ["opacity", "visibility"]) {
      let value = node.style.getPropertyValue(property);
      Object.defineProperty(node.style, property, {
        configurable: true,
        get: () => value,
        set: (next: string) => {
          work.writes += 1;
          value = next;
        },
      });
    }
  };
  for (const root of roots) observe(root);
  const create = document.createElementNS.bind(document);
  const allocation = vi.spyOn(document, "createElementNS").mockImplementation((namespace, tag) => {
    const node = create(namespace, tag);
    observe(node);
    return node;
  });
  const prototype = Object.getPrototypeOf(roots[0]!.style) as FakeNode["style"];
  const remove = Reflect.get(prototype, "removeProperty");
  const removal = vi.spyOn(prototype, "removeProperty");
  removal.mockImplementation(function (this: FakeNode["style"], property) {
    if (property === "visibility" && this.getPropertyValue(property)) work.writes += 1;
    return remove.call(this, property);
  });
  return {
    work,
    restore: () => {
      allocation.mockRestore();
      removal.mockRestore();
      for (const animation of animations) animation.mockRestore();
    },
  };
}
