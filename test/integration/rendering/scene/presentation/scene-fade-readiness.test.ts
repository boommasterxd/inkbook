import { expect, it, vi } from "vitest";
import { createSceneFixture } from "../../../../fixtures/rendering/scene";
import { NAVIGATION_PAGE } from "../../../../fixtures/rendering/pressure-navigation";
import { activeFade, activeFades, fadeFrames } from "../../../../fixtures/rendering/scene-fades";
import {
  FakeNode,
  FakeSceneStore,
  fakeNode,
  fakeRectangleRecord,
} from "../../../../unit/rendering/scene/fakes";

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
  const remove = (historyReplay = false) => {
    store.records.clear();
    scene.renderer.applyDelta({
      historyReplay,
      affected: records.map(({ id, element }) => ({
        id,
        domains: ["visibility"],
        before: element,
        after: null,
      })),
    });
    scene.renderer.clearElementFade(records.map(({ id }) => id));
  };
  const restore = (historyReplay = false) => {
    for (const record of records) store.records.set(record.id, record);
    scene.renderer.applyDelta({
      historyReplay,
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

function expectReleased(fixture: ReturnType<typeof setup>): void {
  expect(fixture.scheduler.pendingCount).toBe(0);
  expect(fixture.renderer.memoryUsage()).toEqual({ pathCacheBytes: 0, motionCacheBytes: 0 });
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
      expect(activeFades(head)).toHaveLength(1);
    }
    expect(fixture.renderer.instrumentation().domExits).toBe(259);
    expect(fixture.renderer.instrumentation().motionTombstones).toBe(0);
    fixture.scheduler.time += 5_000;
    fixture.scheduler.runAll();
    expect(fixture.content.nodes).toHaveLength(0);
  } finally {
    fixture.renderer.destroy();
  }
  expectReleased(fixture);
});

it("fades actual replay removal and progressive restoration for 150ms without generic motion", () => {
  const fixture = setup();
  try {
    fixture.remove(true);
    fixture.scheduler.runNext();
    expect(fixture.renderer.mountedCount).toBe(260);
    expect(fixture.content.nodes.filter((node) => activeFades(node).length > 0)).toHaveLength(128);
    expect(activeFade(fixture.content.nodes[0]!).options.duration).toBe(150);
    fixture.scheduler.time = 149;
    fixture.scheduler.runNext();
    expect(fixture.renderer.mountedCount).toBe(260);
    fixture.scheduler.runNext();
    fixture.scheduler.runNext();
    fixture.scheduler.time = 300;
    fixture.scheduler.runAll();
    expect(fixture.renderer.mountedCount).toBe(0);
    fixture.restore(true);
    fixture.scheduler.runNext();
    expect(fixture.content.nodes.length).toBeGreaterThan(0);
    expect(
      fixture.content.nodes.every((node) => String(node.style.visibility).includes(", hidden)")),
    ).toBe(true);
    fixture.scheduler.runNext();
    const entering = fixture.content.nodes.filter((node) => activeFades(node).length > 0);
    expect(entering).toHaveLength(128);
    expect(
      entering.every(
        (node) =>
          fadeFrames(node)[0]?.includes("--inkbook-history-active-") &&
          activeFade(node).options.duration === 150,
      ),
    ).toBe(true);
    expect(entering.every((node) => !node.style.transform && !node.style.filter)).toBe(true);
    fixture.scheduler.runNext();
    fixture.scheduler.runNext();
    fixture.scheduler.time = 449;
    fixture.scheduler.runNext();
    expect(fixture.content.nodes.every((node) => activeFades(node).length > 0)).toBe(true);
    fixture.scheduler.time = 450;
    fixture.scheduler.runAll();
    expect(fixture.renderer.mountedIds("content")).toEqual(fixture.records.map(({ id }) => id));
    expect(
      fixture.content.nodes.every((node) => activeFades(node).length === 0 && !node.style.opacity),
    ).toBe(true);
    expect(fixture.renderer.instrumentation()).toMatchObject({
      motionTombstones: 0,
      motionEntrances: 0,
    });
  } finally {
    fixture.renderer.destroy();
  }
  expect(fixture.scheduler.pendingCount).toBe(0);
});

it("cancels replay restoration before publication and reverses an admitted entrance batch", () => {
  const fixture = setup();
  try {
    fixture.renderer.setReducedMotion(true);
    fixture.remove(true);
    fixture.scheduler.runAll();
    fixture.renderer.setReducedMotion(false);
    fixture.restore(true);
    fixture.remove(true);
    fixture.scheduler.runAll();
    expect(fixture.renderer.mountedCount).toBe(0);
    fixture.restore(true);
    fixture.scheduler.runNext();
    fixture.scheduler.runNext();
    expect(fixture.content.nodes.filter((node) => activeFades(node).length > 0)).toHaveLength(128);
    fixture.remove(true);
    fixture.scheduler.runNext();
    fixture.scheduler.runNext();
    fixture.scheduler.runNext();
    expect(
      fixture.content.nodes.some(
        (node) =>
          activeFades(node).length > 0 &&
          fadeFrames(node)[0]?.includes("--inkbook-history-active-") === true,
      ),
    ).toBe(false);
    expect(fixture.content.nodes.every((node) => node.style.visibility !== "hidden")).toBe(true);
    fixture.scheduler.time += 400;
    fixture.scheduler.runAll();
    expect(fixture.renderer.mountedCount).toBe(0);
  } finally {
    fixture.renderer.destroy();
  }
});

it("retargets Undo and Redo from the native committed paint and releases completed fades", () => {
  const fixture = setup();
  const node = fixture.content.nodes[0]!;
  Object.defineProperty(node, "isConnected", { get: () => node.parent !== undefined });
  try {
    fixture.remove(true);
    fixture.scheduler.runNext();
    const exit = activeFade(node);
    const exitPaint = vi.spyOn(exit, "commitStyles").mockImplementation(() => {
      Object.assign(node.style, { opacity: "0.63" });
    });
    fixture.restore(true);
    fixture.scheduler.runNext();
    expect(exitPaint).toHaveBeenCalledOnce();
    expect(exit.playState).toBe("idle");
    expect(fadeFrames(node)).toEqual(["0.63", "1"]);
    const entrance = activeFade(node);
    const entrancePaint = vi.spyOn(entrance, "commitStyles").mockImplementation(() => {
      Object.assign(node.style, { opacity: "0.81" });
    });
    fixture.remove(true);
    fixture.scheduler.runNext();
    expect(entrancePaint).toHaveBeenCalledOnce();
    expect(entrance.playState).toBe("idle");
    expect(fadeFrames(node)[0]).toBe("0.81");
    expect(activeFades(node)).toHaveLength(1);
    fixture.scheduler.time += 400;
    fixture.scheduler.runAll();
    expect(fixture.renderer.mountedCount).toBe(0);
    expect(activeFades(node)).toHaveLength(0);
  } finally {
    fixture.renderer.destroy();
  }
  expectReleased(fixture);
});

it.each(["pointer", "reduced"] as const)(
  "settles replay fades and preserves the %s interruption policy for eraser feedback",
  (kind) => {
    const fixture = setup();
    const interrupt = () =>
      kind === "pointer"
        ? fixture.renderer.interruptMotionForPointerDown()
        : fixture.renderer.setReducedMotion(true);
    try {
      fixture.remove(true);
      fixture.scheduler.runNext();
      interrupt();
      fixture.scheduler.runAll();
      expect(fixture.renderer.mountedCount).toBe(0);
      startReplayEntrance(fixture);
      interrupt();
      fixture.scheduler.runAll();
      expect(fixture.renderer.mountedCount).toBe(260);
      expect(
        fixture.content.nodes.every(
          (node) => activeFades(node).length === 0 && !node.style.visibility,
        ),
      ).toBe(true);
      expect(
        fakeNode(fixture.renderer.svg).style.getPropertyValue("--inkbook-history-active-1"),
      ).toBe("");
      fixture.renderer.setReducedMotion(false);
      fixture.renderer.setElementFade([fixture.records[0]!.id], 400);
      interrupt();
      fixture.scheduler.runNext();
      if (kind === "pointer")
        expect(activeFade(fixture.content.nodes[0]!).options.duration).toBe(400);
      else {
        expect(activeFades(fixture.content.nodes[0]!)).toHaveLength(0);
        expect(fixture.content.nodes[0]!.style.opacity).toBe("0");
      }
      fixture.renderer.clearElementFade([fixture.records[0]!.id]);
      fixture.remove(true);
      fixture.renderer.setReducedMotion(true);
      fixture.scheduler.runAll();
      expect(fixture.renderer.mountedCount).toBe(0);
      startReplayEntrance(fixture);
      expect(
        fixture.content.nodes.some((node) =>
          activeFades(node).some((fade) => fade.options.duration === 150),
        ),
      ).toBe(true);
      fixture.scheduler.runNext();
      fixture.scheduler.runNext();
      fixture.scheduler.time += 400;
      fixture.scheduler.runAll();
      expect(fixture.content.nodes.every((node) => activeFades(node).length === 0)).toBe(true);
    } finally {
      fixture.renderer.destroy();
    }
    expect(fixture.scheduler.pendingCount).toBe(0);
  },
);

function setupTrackedFeedback() {
  const fixture = setup();
  return {
    fixture,
    original: [...fixture.content.nodes],
    ids: fixture.records.map(({ id }) => id),
  };
}

it("settles running and queued delete feedback on live reduced motion before removal and Undo", () => {
  const { fixture, original, ids } = setupTrackedFeedback();
  try {
    fixture.renderer.setElementFade(ids, 150);
    expect(original.filter((node) => activeFades(node).length === 1)).toHaveLength(128);
    fixture.scheduler.time += 25;
    fixture.renderer.setReducedMotion(true);
    fixture.remove();
    fixture.scheduler.runAll();
    expect(fixture.renderer.mountedCount).toBe(0);
    expect(fixture.renderer.hasPendingSceneCommit).toBe(false);
    expect(original.every((node) => activeFades(node).length === 0)).toBe(true);
    expect(fixture.scheduler.time).toBeLessThan(150);
    fixture.restore(true);
    fixture.scheduler.runAll();
    expect(fixture.renderer.mountedIds("content")).toEqual(ids);
    expect(
      fixture.content.nodes.every((node) => activeFades(node).length === 0 && !node.style.opacity),
    ).toBe(true);
  } finally {
    fixture.renderer.destroy();
  }
  expectReleased(fixture);
});

function startReplayEntrance(fixture: ReturnType<typeof setup>): void {
  fixture.renderer.setReducedMotion(false);
  fixture.restore(true);
  fixture.scheduler.runNext();
  fixture.scheduler.runNext();
}

it("cancels queued, running and completed opacity exits on Undo, then cleans a subsequent Redo", () => {
  const { fixture, original, ids } = setupTrackedFeedback();
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
      expect(activeFades(node)).toHaveLength(0);
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
  expectReleased(fixture);
});
