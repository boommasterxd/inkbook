import { expect, it, vi } from "vitest";
import { SCENE_PUBLICATION_ROOTS_PER_FRAME } from "../../../../src/rendering/scene/constants";
import {
  createSceneFixture,
  createViewportRectangleStore,
} from "../../../fixtures/rendering/scene";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import { fakeRectangleRecord } from "../../../unit/rendering/scene/fakes";

const INITIAL_GROUP_SIZE = SCENE_PUBLICATION_ROOTS_PER_FRAME + 64;

function createInitialScene() {
  const store = createViewportRectangleStore(INITIAL_GROUP_SIZE * 2, (rank) =>
    rank < INITIAL_GROUP_SIZE ? 10 : 150,
  );
  const committed = vi.fn();
  const scene = createSceneFixture(
    NAVIGATION_PAGE,
    store,
    { height: 100, left: 0, top: 0, width: 100 },
    { deferInitialOverscan: true, onSceneCommitted: committed },
  );
  return { ...scene, store, committed };
}

it("uses an unchanged supplied viewport until a later external layout invalidation", () => {
  const { renderer, scheduler } = createInitialScene();
  scheduler.runAll();
  renderer.resetInstrumentation();
  renderer.invalidateLayout();
  renderer.setViewport({ height: 100, left: 0, top: 0, width: 100 });
  scheduler.runAll();
  expect(renderer.instrumentation().layoutReads).toBe(0);
  renderer.invalidateLayout();
  scheduler.runAll();
  expect(renderer.instrumentation().layoutReads).toBe(1);
  renderer.destroy();
});

it.each(["viewport", "camera", "generation", "layout", "geometry"] as const)(
  "replaces the initial scene proof after a %s change and retains prepared geometry",
  (change) => {
    const { renderer, scheduler, store, committed } = createInitialScene();
    scheduler.runNext();
    expect(renderer.mountedCount).toBe(SCENE_PUBLICATION_ROOTS_PER_FRAME);
    expect(renderer.sceneCommitProof).toBeUndefined();
    scheduler.runAll();
    const proof = renderer.sceneCommitProof;
    expect(renderer.mountedCount).toBe(INITIAL_GROUP_SIZE);
    expect(committed).toHaveBeenCalledOnce();
    if (change === "viewport") renderer.setViewport({ height: 200, left: 0, top: 0, width: 100 });
    else if (change === "camera") renderer.setCamera({ x: 0, zoom: 0.5 });
    else if (change === "generation") renderer.replaceGeneration();
    else if (change === "layout") renderer.invalidateLayout();
    else {
      const rank = INITIAL_GROUP_SIZE + 144;
      const id = `entry-${rank}`;
      store.records.set(id, fakeRectangleRecord(id, rank, 20, 50));
      renderer.applyDelta({ affected: [{ id, domains: ["geometry", "visibility"] }] });
    }
    expect(renderer.sceneCommitProof).toBeUndefined();
    scheduler.runAll();
    expect(renderer.sceneCommitProof).toBeGreaterThan(proof!);
    expect(committed).toHaveBeenCalledTimes(2);
    const expected =
      change === "viewport" || change === "camera"
        ? INITIAL_GROUP_SIZE * 2
        : INITIAL_GROUP_SIZE + (change === "geometry" ? 1 : 0);
    expect(renderer.mountedCount).toBe(expected);
    expect(renderer.instrumentation().geometryBuilds).toBe(expected);
    renderer.destroy();
    expect(scheduler.pendingCount).toBe(0);
  },
);

it.each(["visible", "overscan"] as const)(
  "cancels unpublished %s preparation on disposal",
  (phase) => {
    const { renderer, scheduler, committed } = createInitialScene();
    if (phase === "overscan") {
      scheduler.runAll();
      renderer.releaseInitialOverscan();
    }
    scheduler.runNext();
    expect(scheduler.pendingCount).toBeGreaterThan(0);
    renderer.destroy();
    expect(renderer.sceneCommitProof).toBeUndefined();
    scheduler.runAll();
    expect(committed).toHaveBeenCalledTimes(phase === "visible" ? 0 : 1);
    expect(renderer.mountedCount).toBe(0);
    expect(scheduler.pendingCount).toBe(0);
  },
);
