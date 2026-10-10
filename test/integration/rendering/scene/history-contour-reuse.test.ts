import { expect, it, vi } from "vitest";
import * as geometry from "../../../../src/domain/geometry/element-path";
import * as intersections from "../../../../src/domain/geometry/pressure-boundary-intersections";
import { ElementStore } from "../../../../src/domain/store/public";
import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import { createSceneFixture } from "../../../fixtures/rendering/scene";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { createWorkerSnapshot } from "../../../fixtures/persistence/worker-snapshot";

it("reuses retained contours through real remove, undo, and redo in a 10,000-stroke store", async () => {
  const elements = Array.from({ length: 10_000 }, (_, index) => {
    const element = indexedStroke(index);
    return { ...element, points: [...element.points, element.pivot.x + 4, element.pivot.y + 4, 1] };
  });
  const store = new ElementStore(elements);
  const sceneStore = new ElementSceneStore(store);
  const { renderer, scheduler } = createSceneFixture(createWorkerSnapshot([]).page, sceneStore, {
    height: 100,
    left: 0,
    top: 0,
    width: 100,
  });
  scheduler.runAll();
  const ids = renderer.mountedIds("content").slice(0, 10);
  expect(ids).toHaveLength(10);
  const original = ids.map((id) => store.get(id)!.element);
  const count = renderer.mountedCount;
  const unsubscribe = store.subscribe((delta) =>
    renderer.applyDelta({
      affected: delta.changes.map((change) => ({
        ...change,
        before: (change.before?.element as InkElementV1 | undefined) ?? null,
        after: (change.after?.element as InkElementV1 | undefined) ?? null,
      })),
    }),
  );
  const build = vi.spyOn(geometry, "buildElementPathParts");
  const contour = vi.spyOn(intersections, "intersectPressureBoundaries");
  try {
    renderer.resetInstrumentation();
    const deletion = store.removeWithHistory(ids);
    if (deletion === null) throw new Error("Expected a removal transition.");
    scheduler.runAll();
    expect(renderer.mountedCount).toBe(count - ids.length);
    expect(build).not.toHaveBeenCalled();
    const restored = await store.prepareElementMutation(
      deletion.transition.reverse,
      { shouldYield: () => false, yieldControl: async () => undefined },
      deletion.transition,
    );
    expect(restored.status).toBe("prepared");
    store.commitPreparedElementMutation(restored.token!);
    scheduler.runAll();
    expect(renderer.mountedCount).toBe(count);
    expect(ids.map((id) => store.get(id)!.element)).toEqual(original);
    ids.forEach((id, index) => expect(store.get(id)!.element).toBe(original[index]));
    const replay = await store.prepareElementMutation(
      deletion.transition.forward,
      { shouldYield: () => false, yieldControl: async () => undefined },
      deletion.transition,
    );
    expect(replay.status).toBe("prepared");
    store.commitPreparedElementMutation(replay.token!);
    scheduler.runAll();
    expect(renderer.mountedCount).toBe(count - ids.length);
    expect(renderer.instrumentation().geometryBuilds).toBe(0);
    expect(build).not.toHaveBeenCalled();
    expect(contour).not.toHaveBeenCalled();
    expect(renderer.instrumentation().detachedCacheEntries).toBe(0);
    expect(renderer.instrumentation().motionCacheEntries).toBe(0);
  } finally {
    build.mockRestore();
    contour.mockRestore();
    unsubscribe();
    renderer.destroy();
    sceneStore.release();
  }
  scheduler.runAll();
  expect(renderer.memoryUsage()).toEqual({ pathCacheBytes: 0, motionCacheBytes: 0 });
  expect(scheduler.pendingCount).toBe(0);
});
