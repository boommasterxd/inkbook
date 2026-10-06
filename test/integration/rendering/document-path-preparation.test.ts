import { expect, it, vi } from "vitest";
import { ElementStore } from "../../../src/domain/store/public";
import { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";
import { InteractiveWorkPriority } from "../../../src/editor/session/interactive-work-priority";
import { buildElementPathParts } from "../../../src/domain/geometry/element-path";
import type { ScenePathPreparationObserver } from "../../../src/domain/geometry/prepared-scene-paths";
import { createSceneFixture } from "../../fixtures/rendering/scene";
import { NAVIGATION_PAGE } from "../../fixtures/rendering/pressure-navigation";
import { indexedStroke } from "../../fixtures/editor/stroke";

function fixture() {
  const element = { ...indexedStroke(0), pivot: { x: 20, y: 2000 }, points: [20, 2000, 0.5] };
  const domain = new ElementStore([element]);
  const store = new ElementSceneStore(domain);
  const publish = vi.fn();
  const pressure = store.pressureGeometry.bind(store);
  vi.spyOn(store, "pressureGeometry").mockImplementation((id, version) => {
    const port = pressure(id, version);
    return {
      ...port,
      publishPath: (parts) => {
        publish(parts);
        port.publishPath?.(parts);
      },
    };
  });
  const priority = new InteractiveWorkPriority();
  let observer!: ScenePathPreparationObserver;
  let signal!: AbortSignal;
  const request = vi.fn(
    (
      _ids: readonly string[],
      cancellation: AbortSignal,
      progress?: ScenePathPreparationObserver,
    ) => {
      observer = progress!;
      signal = cancellation;
      return new Promise<undefined>(() => undefined);
    },
  );
  store.prepareScenePaths = request;
  const scene = createSceneFixture(
    NAVIGATION_PAGE,
    store,
    { height: 100, left: 0, top: 0, width: 100 },
    {
      deferInitialOverscan: true,
      waitForBackground: () => priority.waitForBackground(),
      isInputActive: () => priority.gestureActive,
    },
  );
  return {
    ...scene,
    store,
    domain,
    priority,
    request,
    element,
    publish,
    observer: () => observer,
    signal: () => signal,
  };
}

it("waits for viewport handoff and the existing navigation quiet gate without polling", async () => {
  const state = fixture();
  try {
    state.scheduler.runAll();
    expect(state.request).not.toHaveBeenCalled();
    state.priority.setInputActive(true, "navigation");
    state.renderer.releaseInitialOverscan();
    state.scheduler.runAll();
    expect(state.scheduler.pendingCount).toBe(0);
    expect(state.request).not.toHaveBeenCalled();
    state.priority.setInputActive(false, "navigation");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    state.scheduler.runAll();
    expect(state.request).toHaveBeenCalledOnce();
    expect(state.observer().speculative).toBe(true);
    expect(state.observer().navigationReserve).toBe(false);
    expect(state.scheduler.pendingCount).toBe(0);
    const before = state.renderer.instrumentation();
    state
      .observer()
      .onProgress([{ id: state.element.id, parts: buildElementPathParts(state.element) }]);
    state.scheduler.runAll();
    const after = state.renderer.instrumentation();
    expect(after.pathCacheEntries).toBeGreaterThan(before.pathCacheEntries);
    expect(after.contentAttributeWrites).toBe(before.contentAttributeWrites);
    expect(after.domRootsPublished).toBe(before.domRootsPublished);
    expect(state.publish).not.toHaveBeenCalled();
    expect(state.store.memoryUsage().pressurePathCacheBytes).toBe(0);
    expect(state.domain.instrumentation.snapshotMaterializations).toBe(0);
    expect(state.scheduler.pendingCount).toBe(0);
  } finally {
    state.renderer.destroy();
    state.priority.dispose();
    state.store.release();
  }
  expect(state.signal().aborted).toBe(true);
  expect(state.scheduler.pendingCount).toBe(0);
});

it("cancels idle worker ownership on camera activity and ignores a waiter after disposal", async () => {
  const state = fixture();
  state.scheduler.runAll();
  state.renderer.releaseInitialOverscan();
  state.scheduler.runAll();
  expect(state.request).toHaveBeenCalledOnce();
  const obsolete = state.signal();
  state.priority.setInputActive(true, "navigation");
  state.renderer.setViewport({ height: 100, left: 0, top: 1, width: 100 });
  expect(obsolete.aborted).toBe(true);
  state.scheduler.runAll();
  expect(state.scheduler.pendingCount).toBe(0);
  state.renderer.destroy();
  state.priority.setInputActive(false, "navigation");
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(state.scheduler.pendingCount).toBe(0);
  expect(state.request).toHaveBeenCalledOnce();
  state.priority.dispose();
  state.store.release();
});

it("resumes a paused file cursor when active-document memory pressure is released", () => {
  const state = fixture();
  try {
    state.scheduler.runAll();
    state.renderer.releaseInitialOverscan();
    state.scheduler.runAll();
    expect(state.request).toHaveBeenCalledOnce();
    state.renderer.setActiveDocumentMemoryPressure(true);
    expect(state.signal().aborted).toBe(true);
    expect(state.scheduler.pendingCount).toBe(0);
    state.renderer.setActiveDocumentMemoryPressure(false);
    state.scheduler.runAll();
    expect(state.request).toHaveBeenCalledTimes(2);
    expect(state.signal().aborted).toBe(false);
  } finally {
    state.renderer.destroy();
    state.priority.dispose();
    state.store.release();
  }
});
