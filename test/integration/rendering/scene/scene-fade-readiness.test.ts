import { expect, it, vi } from "vitest";
import { createSceneFixture } from "../../../fixtures/rendering/scene";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import {
  FakeNode,
  FakeSceneStore,
  fakeNode,
  fakeRectangleRecord,
} from "../../../unit/rendering/scene/fakes";

function setup() {
  const records = Array.from({ length: 260 }, (_, rank) =>
    fakeRectangleRecord(`feedback-${rank}`, rank, 10),
  );
  const store = new FakeSceneStore();
  for (const record of records) store.records.set(record.id, record);
  const scene = createSceneFixture(NAVIGATION_PAGE, store);
  scene.renderer.setReducedMotion(true);
  scene.scheduler.runAll();
  scene.renderer.setReducedMotion(false);
  const content = fakeNode(scene.renderer.svg).nodes[1]!.nodes[4]!;
  const remove = () => {
    store.records.clear();
    scene.renderer.applyDelta({
      affected: records.map(({ id, element }) => ({
        id,
        domains: ["visibility"],
        before: element,
        after: null,
      })),
    });
    scene.renderer.clearElementFade(records.map(({ id }) => id));
  };
  const restore = () => {
    for (const record of records) store.records.set(record.id, record);
    scene.renderer.applyDelta({
      affected: records.map(({ id, element }) => ({
        id,
        domains: ["visibility"],
        before: null,
        after: element,
      })),
    });
  };
  return { ...scene, records, store, content, remove, restore };
}

it("removes completed opacity exits while a lower-rank opacity exit is still running", () => {
  const fixture = setup();
  const head = fixture.content.nodes[0]!;
  try {
    fixture.renderer.setElementFade([fixture.records[0]!.id], 5_000);
    fixture.renderer.setElementFade(
      fixture.records.slice(1).map(({ id }) => id),
      10,
    );
    fixture.remove();
    for (let frame = 0; fixture.renderer.mountedCount > 1; frame += 1) {
      expect(frame).toBeLessThan(10);
      fixture.scheduler.time += 20;
      fixture.scheduler.runNext();
      expect(head.parent).toBe(fixture.content);
      expect(head.style.animation).toContain("inkbook-element-opacity-exit");
    }
    expect(fixture.renderer.instrumentation().domExits).toBe(259);
    expect(fixture.renderer.instrumentation().motionTombstones).toBe(0);
    fixture.scheduler.time += 5_000;
    fixture.scheduler.runAll();
    expect(fixture.content.nodes).toHaveLength(0);
  } finally {
    fixture.renderer.destroy();
  }
  expect(fixture.scheduler.pendingCount).toBe(0);
  expect(fixture.renderer.memoryUsage()).toEqual({ pathCacheBytes: 0, motionCacheBytes: 0 });
});

it("cancels queued, running and completed opacity exits on Undo, then cleans a subsequent Redo", () => {
  const fixture = setup();
  const original = [...fixture.content.nodes];
  const ids = fixture.records.map(({ id }) => id);
  try {
    fixture.renderer.setElementFade(ids, 10);
    fixture.remove();
    fixture.scheduler.time += 20;
    fixture.scheduler.runNext();
    expect(fixture.renderer.mountedCount).toBe(196);
    expect(original.filter((node) => !node.parent)).toHaveLength(64);
    const retained = fixture.content.nodes.filter((node) => original.includes(node));
    fixture.restore();
    fixture.scheduler.runAll();
    expect(fixture.renderer.mountedIds("content")).toEqual(ids);
    expect(fixture.content.nodes.map((node) => node.attributes.get("d"))).toEqual(
      original.map((node) => node.attributes.get("d")),
    );
    for (const node of retained) {
      expect(fixture.content.nodes).toContain(node);
      expect(node.style.animation || "").toBe("");
      expect(node.style.filter || "").toBe("");
      expect(node.style.opacity || "").toBe("");
    }
    fixture.renderer.setReducedMotion(true);
    fixture.renderer.setElementFade(ids, 10);
    fixture.remove();
    fixture.scheduler.runAll();
    expect(fixture.renderer.mountedCount).toBe(0);
    expect(fixture.renderer.instrumentation().motionTombstones).toBe(0);
  } finally {
    fixture.renderer.destroy();
  }
  expect(fixture.scheduler.pendingCount).toBe(0);
});

it("repairs a protected readiness classification before it can block other ready exits", () => {
  const fixture = setup();
  const id = fixture.records[0]!.id;
  const head = fixture.content.nodes[0]!;
  const exits = vi.spyOn(FakeNode.prototype, "remove");
  try {
    fixture.renderer.setElementFade([id], 5_000);
    fixture.renderer.setElementFade(
      fixture.records.slice(1).map(({ id: next }) => next),
      0,
    );
    fixture.renderer.setPreviewTransform([id], "translate(1 0)", 1);
    fixture.remove();
    fixture.scheduler.runNext();
    fixture.renderer.clearPreviewTransforms();
    for (let frame = 0; fixture.renderer.mountedCount > 1; frame += 1) {
      expect(frame).toBeLessThan(10);
      fixture.scheduler.runNext();
    }
    expect(head.parent).toBe(fixture.content);
    expect(exits).toHaveBeenCalled();
    fixture.scheduler.time += 5_000;
    fixture.scheduler.runAll();
    expect(fixture.content.nodes).toHaveLength(0);
  } finally {
    exits.mockRestore();
    fixture.renderer.destroy();
  }
});

it("drops indexed waiting exits on disposal without late publication", () => {
  const fixture = setup();
  fixture.renderer.setElementFade(
    fixture.records.map(({ id }) => id),
    10_000,
  );
  fixture.remove();
  fixture.scheduler.runNext();
  expect(fixture.renderer.memoryUsage().pathCacheBytes).toBeGreaterThan(0);
  fixture.renderer.destroy();
  fixture.scheduler.time += 10_000;
  fixture.scheduler.runAll();
  expect(fixture.renderer.mountedCount).toBe(0);
  expect(fixture.renderer.memoryUsage()).toEqual({ pathCacheBytes: 0, motionCacheBytes: 0 });
  expect(fixture.scheduler.pendingCount).toBe(0);
});
