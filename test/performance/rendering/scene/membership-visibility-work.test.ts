import { expect, it, vi } from "vitest";
import {
  createIndexedSceneStore,
  createSceneFixture,
  createViewportRectangleStore,
  replaySceneMembership,
} from "../../../fixtures/rendering/scene";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import { FakeDocument, FakeNode, fakeNode } from "../../../unit/rendering/scene/fakes";

const VISIBLE_COUNT = 64;

it.each([1_000, 10_000])(
  "bounds actual history animation starts and style writes with %i retained roots",
  (count) => {
    const records = createViewportRectangleStore(count, (rank) =>
      rank < VISIBLE_COUNT ? 10 : 1_100,
    );
    const indexed = createIndexedSceneStore(records);
    const { document, renderer, scheduler } = createSceneFixture(
      NAVIGATION_PAGE,
      indexed.store,
      undefined,
      { scrollPreloadMarginPx: 800 },
    );
    scheduler.runAll(200);
    expect(renderer.mountedCount).toBe(count);
    const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
    const entries = [...records.records.values()];
    const observed = observeFadeWrites(document, content.nodes);
    const remove = vi.spyOn(FakeNode.prototype, "remove");
    const replay = (exit: boolean) => {
      replaySceneMembership(renderer, records, entries, exit ? "exit" : "enter");
    };
    const frame = () => {
      const removals = remove.mock.calls.length;
      const writes = observed.work.writes;
      scheduler.runNext();
      expect(remove.mock.calls.length - removals).toBeLessThanOrEqual(64);
      // Two fade style writes per admitted target plus fresh visible entrance concealment.
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
      expect(observed.work.writes).toBe(128);
      replay(false);
      frame();
      expect(observed.work.starts).toBe(VISIBLE_COUNT * 2);
      expect(observed.work.writes).toBe(128 + VISIBLE_COUNT);
      replay(true);
      frame();
      expect(observed.work.starts).toBe(VISIBLE_COUNT * 3);
      expect(observed.work.writes).toBe(256 + VISIBLE_COUNT);
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
      expect(content.nodes.filter((node) => Boolean(node.style.animation))).toHaveLength(
        VISIBLE_COUNT,
      );
      scheduler.time = 800;
      while (scheduler.pendingCount > 0) frame();
      expect(observed.work.writes).toBeLessThanOrEqual(count + VISIBLE_COUNT * 7);
      expect(content.nodes.every((node) => !node.style.animation && !node.style.visibility)).toBe(
        true,
      );
      expect(renderer.instrumentation()).toMatchObject({ motionTombstones: 0, motionEntrances: 0 });
    } finally {
      observed.restore();
      remove.mockRestore();
      renderer.destroy();
    }
    expect(scheduler.pendingCount).toBe(0);
    expect(renderer.memoryUsage()).toEqual({ pathCacheBytes: 0, motionCacheBytes: 0 });
  },
);

function observeFadeWrites(document: FakeDocument, roots: readonly FakeNode[]) {
  const work = { writes: 0, starts: 0 };
  const watched = new WeakSet<FakeNode>();
  const observe = (node: FakeNode) => {
    if (watched.has(node)) return;
    watched.add(node);
    for (const property of ["animation", "opacity", "visibility"]) {
      let value = node.style.getPropertyValue(property);
      Object.defineProperty(node.style, property, {
        configurable: true,
        get: () => value,
        set: (next: string) => {
          work.writes += 1;
          if (property === "animation" && next.startsWith("inkbook-element-")) work.starts += 1;
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
    },
  };
}
