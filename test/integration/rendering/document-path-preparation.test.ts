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
    release: () => {
      scene.renderer.destroy();
      priority.dispose();
      store.release();
      domain.releasePreparedPressureGeometry();
    },
  };
}

function startDocumentPaths(state: ReturnType<typeof fixture>): void {
  state.scheduler.runAll();
  state.renderer.releaseInitialOverscan();
  state.scheduler.runAll();
  expect(state.request).toHaveBeenCalledOnce();
}

async function releaseNavigationQuietGate(state: ReturnType<typeof fixture>): Promise<void> {
  state.priority.setInputActive(false, "navigation");
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function pauseForNavigation(state: ReturnType<typeof fixture>, top = 1): void {
  state.priority.setInputActive(true, "navigation");
  state.renderer.setViewport({ height: 100, left: 0, top, width: 100 });
  expect(state.signal().aborted).toBe(true);
  state.scheduler.runAll();
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
    await releaseNavigationQuietGate(state);
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
    state.release();
  }
  expect(state.signal().aborted).toBe(true);
  expect(state.scheduler.pendingCount).toBe(0);
});

it("cancels idle worker ownership on camera activity and ignores a waiter after disposal", async () => {
  const state = fixture();
  startDocumentPaths(state);
  pauseForNavigation(state);
  expect(state.scheduler.pendingCount).toBe(0);
  state.renderer.destroy();
  await releaseNavigationQuietGate(state);
  expect(state.scheduler.pendingCount).toBe(0);
  expect(state.request).toHaveBeenCalledOnce();
  state.priority.dispose();
  state.store.release();
});

it("keeps delivered contours across a navigation pause and adopts them after quiet admission", async () => {
  const state = fixture();
  try {
    startDocumentPaths(state);
    const obsoleteObserver = state.observer();
    const paths = [{ id: state.element.id, parts: buildElementPathParts(state.element) }];
    obsoleteObserver.onProgress(paths);
    const before = state.renderer.instrumentation();
    pauseForNavigation(state);
    expect(state.renderer.instrumentation().pathCacheEntries).toBe(before.pathCacheEntries);
    expect(state.scheduler.pendingCount).toBe(0);
    obsoleteObserver.onProgress(paths);
    await releaseNavigationQuietGate(state);
    state.scheduler.runAll();
    expect(state.request).toHaveBeenCalledOnce();
    expect(state.renderer.instrumentation().pathCacheEntries).toBe(before.pathCacheEntries + 1);
    expect(state.publish).not.toHaveBeenCalled();
    expect(state.scheduler.pendingCount).toBe(0);
  } finally {
    state.release();
  }
});

it("mounts a delivered offscreen contour during navigation without another worker request or local build", async () => {
  const state = fixture();
  startDocumentPaths(state);
  const obsoleteObserver = state.observer();
  const parts = buildElementPathParts(state.element);
  obsoleteObserver.onProgress([{ id: state.element.id, parts }]);
  const before = state.renderer.instrumentation();
  pauseForNavigation(state, 1990);
  const after = state.renderer.instrumentation();
  expect(state.renderer.mountedCount).toBe(1);
  expect(state.request).toHaveBeenCalledOnce();
  expect(state.publish).toHaveBeenCalledOnce();
  expect(state.publish.mock.calls[0]![0]).toBe(parts);
  expect(after.geometryBuilds).toBe(before.geometryBuilds);
  expect(after.domEntrants - before.domEntrants).toBe(1);
  expect(after.domRootsPublished - before.domRootsPublished).toBe(1);
  expect(state.scheduler.pendingCount).toBe(0);
  state.release();
  obsoleteObserver.onProgress([{ id: state.element.id, parts }]);
  await Promise.resolve();
  expect(state.publish).toHaveBeenCalledOnce();
  expect(state.store.memoryUsage().pressurePathCacheBytes).toBe(0);
  expect(state.scheduler.pendingCount).toBe(0);
});

it("resumes a paused file cursor when active-document memory pressure is released", () => {
  const state = fixture();
  try {
    startDocumentPaths(state);
    state.renderer.setActiveDocumentMemoryPressure(true);
    expect(state.signal().aborted).toBe(true);
    expect(state.scheduler.pendingCount).toBe(0);
    state.renderer.setActiveDocumentMemoryPressure(false);
    state.scheduler.runAll();
    expect(state.request).toHaveBeenCalledTimes(2);
    expect(state.signal().aborted).toBe(false);
  } finally {
    state.release();
  }
});

it("pauses file prewarm without blocking required scene commits and rejects late progress", () => {
  const state = fixture();
  try {
    startDocumentPaths(state);
    const obsoleteObserver = state.observer();
    const obsoleteSignal = state.signal();
    state.renderer.setDocumentPrewarmEnabled(false);
    expect(obsoleteSignal.aborted).toBe(true);
    state.renderer.setScheme("dark");
    state.renderer.invalidateLayout(true);
    state.scheduler.runAll();
    expect(state.renderer.hasPendingSceneCommit).toBe(false);
    expect(state.scheduler.pendingCount).toBe(0);
    const before = state.renderer.instrumentation();
    obsoleteObserver.onProgress([
      { id: state.element.id, parts: buildElementPathParts(state.element) },
    ]);
    state.scheduler.runAll();
    expect(state.renderer.instrumentation().pathCacheEntries).toBe(before.pathCacheEntries);
    expect(state.request).toHaveBeenCalledOnce();
    expect(state.scheduler.pendingCount).toBe(0);
    state.renderer.setDocumentPrewarmEnabled(true);
    state.renderer.setDocumentPrewarmEnabled(true);
    state.scheduler.runAll();
    expect(state.request).toHaveBeenCalledTimes(2);
    expect(state.signal().aborted).toBe(false);
  } finally {
    state.release();
  }
  expect(state.scheduler.pendingCount).toBe(0);
});
