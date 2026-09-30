import { expect, it, vi } from "vitest";
import {
  createSceneFixture,
  createViewportRectangleStore,
} from "../../../fixtures/rendering/scene";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import { fakeRectangleRecord } from "../../../unit/rendering/scene/fakes";

it.each(["viewport", "camera", "generation", "layout", "geometry"] as const)(
  "replaces the initial scene proof after a %s change and retains prepared geometry",
  (change) => {
    const store = createViewportRectangleStore(256, (rank) => (rank < 128 ? 10 : 150));
    const committed = vi.fn();
    const { renderer, scheduler } = createSceneFixture(
      NAVIGATION_PAGE,
      store,
      { height: 100, left: 0, top: 0, width: 100 },
      { deferInitialOverscan: true, onSceneCommitted: committed },
    );
    scheduler.runNext();
    expect(renderer.mountedCount).toBe(64);
    expect(renderer.sceneCommitProof).toBeUndefined();
    scheduler.runAll();
    const proof = renderer.sceneCommitProof;
    expect(renderer.mountedCount).toBe(128);
    expect(committed).toHaveBeenCalledOnce();
    if (change === "viewport") renderer.setViewport({ height: 200, left: 0, top: 0, width: 100 });
    else if (change === "camera") renderer.setCamera({ x: 0, zoom: 0.5 });
    else if (change === "generation") renderer.replaceGeneration();
    else if (change === "layout") renderer.invalidateLayout();
    else {
      store.records.set("entry-200", fakeRectangleRecord("entry-200", 200, 20, 50));
      renderer.applyDelta({ affected: [{ id: "entry-200", domains: ["geometry", "visibility"] }] });
    }
    expect(renderer.sceneCommitProof).toBeUndefined();
    scheduler.runAll();
    expect(renderer.sceneCommitProof).toBeGreaterThan(proof!);
    expect(committed).toHaveBeenCalledTimes(2);
    const expected =
      change === "viewport" || change === "camera" ? 256 : change === "geometry" ? 129 : 128;
    expect(renderer.mountedCount).toBe(expected);
    expect(renderer.instrumentation().geometryBuilds).toBe(expected);
    renderer.destroy();
    expect(scheduler.pendingCount).toBe(0);
  },
);

it.each(["visible", "overscan"] as const)(
  "cancels unpublished %s preparation on disposal",
  (phase) => {
    const store = createViewportRectangleStore(256, (rank) => (rank < 128 ? 10 : 150));
    const committed = vi.fn();
    const { renderer, scheduler } = createSceneFixture(
      NAVIGATION_PAGE,
      store,
      { height: 100, left: 0, top: 0, width: 100 },
      { deferInitialOverscan: true, onSceneCommitted: committed },
    );
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
