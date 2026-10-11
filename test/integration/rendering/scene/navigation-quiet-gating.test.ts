import { expect, it, vi } from "vitest";
import { ElementStore } from "../../../../src/domain/store/public";
import { InteractiveWorkPriority } from "../../../../src/editor/session/interactive-work-priority";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import { ScenePathCache } from "../../../../src/rendering/scene/path-cache";
import { createSceneFixture } from "../../../fixtures/rendering/scene";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";

function setup() {
  const elements = Array.from({ length: 10_000 }, (_, rank) => {
    const y = rank === 0 ? 450 : rank === 1 ? 900 : 10_000;
    return {
      ...indexedStroke(rank),
      pivot: { x: 20, y },
      points: [20, y, 0.5, 21, y, 0.5],
    };
  });
  const domain = new ElementStore(elements);
  const store = new ElementSceneStore(domain);
  const priority = new InteractiveWorkPriority();
  const releaseLease = priority.begin();
  const wait = vi.fn(() => priority.waitForBackground());
  const scene = createSceneFixture(
    NAVIGATION_PAGE,
    store,
    { height: 100, left: 0, top: 0, width: 100 },
    { waitForBackground: wait, isInputActive: () => priority.inputActive },
  );
  scene.renderer.setReducedMotion(true);
  scene.scheduler.runAll();
  return { ...scene, domain, elements, store, priority, releaseLease, wait };
}

async function flushLeaseRelease(fixture: ReturnType<typeof setup>): Promise<void> {
  fixture.releaseLease();
  await fixture.wait.mock.results[0]!.value;
  expect(fixture.scheduler.pendingCount).toBe(1);
  fixture.scheduler.runAll();
}

it("publishes required geometry during a history lease and starts reserve geometry only after release", async () => {
  const fixture = setup();
  const builds = vi.spyOn(ScenePathCache.prototype, "startPreparation");
  try {
    expect(fixture.priority.inputActive).toBe(false);
    fixture.renderer.setViewport({ height: 100, left: 0, top: 400, width: 100 });
    fixture.scheduler.runAll();
    expect(fixture.renderer.mountedIds("content")).toEqual([fixture.elements[0]!.id]);
    expect(builds.mock.calls.map(([element]) => element.id)).toEqual([fixture.elements[0]!.id]);
    expect(fixture.wait).toHaveBeenCalledOnce();
    expect(fixture.scheduler.pendingCount).toBe(0);
    await flushLeaseRelease(fixture);
    expect(builds.mock.calls.map(([element]) => element.id)).toEqual(
      fixture.elements.slice(0, 2).map(({ id }) => id),
    );
    expect(fixture.renderer.mountedIds("content")).toEqual([fixture.elements[0]!.id]);
    expect(fixture.domain.instrumentation.snapshotMaterializations).toBe(0);
    expect(fixture.domain.instrumentation.bandScans).toBe(0);
  } finally {
    builds.mockRestore();
    fixture.renderer.destroy();
    fixture.priority.dispose();
    fixture.store.release();
  }
  expect(fixture.scheduler.pendingCount).toBe(0);
  expect(fixture.renderer.memoryUsage().pathCacheBytes).toBe(0);
  expect(fixture.renderer.memoryUsage().motionCacheBytes).toBe(0);
});

it.each(["dispose", "pressure"] as const)(
  "does not restart reserve work when a quiet waiter is interrupted by %s",
  async (interruption) => {
    const fixture = setup();
    const builds = vi.spyOn(ScenePathCache.prototype, "startPreparation");
    try {
      fixture.renderer.setViewport({ height: 100, left: 0, top: 400, width: 100 });
      fixture.scheduler.runAll();
      expect(builds).toHaveBeenCalledOnce();
      if (interruption === "dispose") fixture.renderer.destroy();
      else fixture.renderer.setActiveDocumentMemoryPressure(true);
      fixture.releaseLease();
      await fixture.wait.mock.results[0]!.value;
      fixture.scheduler.runAll();
      expect(builds).toHaveBeenCalledOnce();
      expect(fixture.scheduler.pendingCount).toBe(0);
    } finally {
      builds.mockRestore();
      fixture.renderer.destroy();
      fixture.priority.dispose();
      fixture.store.release();
    }
    expect(fixture.renderer.memoryUsage()).toEqual({ pathCacheBytes: 0, motionCacheBytes: 0 });
  },
);
