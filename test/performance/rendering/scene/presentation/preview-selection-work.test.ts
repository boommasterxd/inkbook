import { describe, expect, it, vi } from "vitest";
import { createSelectionEdgePreview } from "../../../../fixtures/obsidian/selection-edge-preview";
import { ElementStore } from "../../../../../src/domain/store/public";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import { SceneElementPreviews } from "../../../../../src/rendering/scene/presentation/scene-element-previews";
import { SceneContentRenderer } from "../../../../../src/rendering/scene/content-renderer";
import { createAllElementSnapshot } from "../../../../unit/persistence/serialization/fixtures";
import { fakeRectangleRecord } from "../../../../unit/rendering/scene/fakes";
import { createSceneFixture } from "../../../../fixtures/rendering/scene";
import { createDenseSelectionPreview } from "../../../../fixtures/rendering/selection-preview";
import { ProgressivePreviewPath } from "../../../../../src/rendering/scene/content/progressive-preview-path";
import { takeImmutableElementOwnership } from "../../../../../src/domain/store/records/immutability";
import { MovePreview } from "../../../../../src/obsidian/embeds/active-editor/previews/move-preview";
import { SelectionEdgeAutoScroller } from "../../../../../src/obsidian/embeds/active-editor/previews/selection-edge-scroll";
import { SelectionFrameSession } from "../../../../../src/editor/selection/public";
import { ManualFrameScheduler } from "../../../../fixtures/obsidian/manual-frame-scheduler";
import { CanonicalElementPathPreparation } from "../../../../../src/domain/geometry/canonical-element-path-preparation";
import { selectionOverlayPaths } from "../../../../../src/obsidian/embeds/active-editor/previews/selection-overlay-path";
import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import * as elementPath from "../../../../../src/domain/geometry/element-path";
import { createViewportRectangleStore } from "../../../../fixtures/rendering/scene";
import { fakeNode } from "../../../../unit/rendering/scene/fakes";

it.each([1_000, 10_000])(
  "does no scene work when clearing absent previews with %s mounted elements",
  (count) => {
    const store = createViewportRectangleStore(count, () => 20);
    const { renderer, scheduler } = createSceneFixture(createAllElementSnapshot().page, store);
    renderer.setReducedMotion(true);
    scheduler.runAll();
    expect(renderer.mountedCount).toBe(count);
    const get = vi.spyOn(store, "get");
    const build = vi.spyOn(elementPath, "buildElementPathParts");
    renderer.resetInstrumentation();
    try {
      for (let input = 0; input < 2; input += 1) {
        renderer.clearProgressiveElementPreviews();
        renderer.clearElementPreviews();
        renderer.clearPreviewTransforms();
      }
      expect(get).not.toHaveBeenCalled();
      expect(build).not.toHaveBeenCalled();
      expect(scheduler.pendingCount).toBe(0);
      expect(renderer.instrumentation().attributeWrites).toBe(0);
    } finally {
      get.mockRestore();
      build.mockRestore();
      renderer.destroy();
    }
  },
);

it("builds exact preview geometry only for mounted elements and adopts it on viewport reentry", () => {
  const store = createViewportRectangleStore(10_000, (rank) => rank * 1_000);
  const viewport = { height: 100, left: 0, top: 0, width: 100 };
  const { renderer, scheduler } = createSceneFixture(
    createAllElementSnapshot().page,
    store,
    viewport,
  );
  renderer.setReducedMotion(true);
  scheduler.runAll();
  expect(renderer.mountedCount).toBe(1);
  const previews = [...store.records.values()].map(({ element }) => {
    if (element.kind !== "rectangle") throw new TypeError("Expected a rectangle.");
    return { ...element, width: 40 };
  });
  const build = vi.spyOn(elementPath, "buildElementPathParts");
  const get = vi.spyOn(store, "get");
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  try {
    renderer.setElementPreviews(previews, 1);
    renderer.flushPointerFeedbackFrame();
    expect(build).toHaveBeenCalledExactlyOnceWith(previews[0]);
    expect(get).toHaveBeenCalledExactlyOnceWith(previews[0]!.id);
    renderer.setViewport({ ...viewport, top: 9_999_000 });
    scheduler.runAll();
    const latest = previews[9_999]!;
    expect(renderer.mountedIds("content")).toEqual([latest.id]);
    expect(content.nodes[content.nodes.length - 1]!.attributes.get("d")).toBe(
      elementPath.buildElementPathParts(latest)[0]!.d,
    );
    renderer.clearElementPreviews();
    scheduler.runAll();
    expect(get.mock.calls.every(([id]) => id === previews[0]!.id || id === latest.id)).toBe(true);
    expect(renderer.mountedCount).toBe(1);
    expect(content.nodes).toHaveLength(1);
    expect(content.nodes[0]!.attributes.get("d")).toBe(
      elementPath.buildElementPathParts(store.records.get(latest.id)!.element)[0]!.d,
    );
    get.mockClear();
    build.mockClear();
    renderer.clearElementPreviews();
    expect(get).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(scheduler.pendingCount).toBe(0);
  } finally {
    get.mockRestore();
    build.mockRestore();
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
  expect(renderer.memoryUsage()).toEqual({ pathCacheBytes: 0, motionCacheBytes: 0 });
});

describe("progressive snapshot ownership", () => {
  it("rechecks one owned shape per admitted version while retaining its path until cancellation", () => {
    const { renderer, scheduler, ids, store } = createDenseSelectionPreview(300);
    // This scenario supplies immutable shapes, matching the authoritative Store contract.
    for (const record of store.records.values()) {
      takeImmutableElementOwnership(record.element);
    }
    const paths = new Set<ProgressivePreviewPath>();
    const materialize = vi.fn((id: string) => store.get(id)?.element);
    const step = vi.spyOn(ProgressivePreviewPath.prototype, "step").mockImplementation(function (
      this: ProgressivePreviewPath,
    ) {
      paths.add(this);
      scheduler.time += 20;
      return false;
    });
    const cancel = vi.spyOn(ProgressivePreviewPath.prototype, "cancel");
    try {
      for (const version of [1, 2, 3]) {
        renderer.setProgressiveElementPreviews(ids, materialize, version, {
          transform: `scale(${version + 1} 1)`,
          inverse: `scale(${1 / (version + 1)} 1)`,
        });
        renderer.flushPointerFeedbackFrame(scheduler.time);
        scheduler.runNext();
        expect(materialize).toHaveBeenCalledTimes(version);
      }
      expect(paths.size).toBe(1);
      expect(materialize).toHaveBeenCalledTimes(3);
      renderer.clearProgressiveElementPreviews();
      scheduler.runAll();
      expect(cancel).toHaveBeenCalledOnce();
      expect(materialize).toHaveBeenCalledTimes(3);
    } finally {
      step.mockRestore();
      cancel.mockRestore();
      renderer.destroy();
    }
  });
});

it.each([1_000, 2_000])(
  "translates %s mounted selections once per input without repeating unchanged edge feedback",
  (count) => {
    const scene = createDenseSelectionPreview(count, false);
    const store = new ElementStore([...scene.store.records.values()].map(({ element }) => element));
    const sceneStore = new ElementSceneStore(store);
    const selection = new Set(scene.ids);
    const selectedGeometry = scene.ids.map((id) => {
      const record = store.get(id)!;
      return { bounds: record.bounds, element: record.element as InkElementV1 };
    });
    const selectionFrames = new SelectionFrameSession();
    const overlay = selectionOverlayPaths(selectedGeometry, {
      pageToScreen: (point) => point,
      zoom: 1,
      frame: selectionFrames.current(selectedGeometry),
    });
    scene.renderer.setSelectedElements(selection);
    scene.renderer.setSelectionOverlayPath(overlay.outline, "accent", overlay.handles);
    scene.scheduler.runAll();
    const frames = new ManualFrameScheduler();
    const scroll = vi.fn();
    const scroller = new SelectionEdgeAutoScroller({
      cancelFrame: (handle) => frames.cancelFrame(handle),
      onFrame: () => edge.refresh(),
      onScroll: scroll,
      readViewport: () => ({ left: -1_000, right: 1_000, top: -1_000, bottom: 1_000 }),
      requestFrame: (callback) => frames.requestFrame(callback),
    });
    const edge = createSelectionEdgePreview(scroller);
    const preview = new MovePreview({
      history: {} as never,
      preparedHistory: {} as never,
      renderer: scene.renderer,
      sceneStore,
      store,
      frameScheduler: frames,
      selection: () => selection,
      selectionGeometry: () => selectedGeometry,
      selectionFrames,
      setSelection: vi.fn(),
      pageToScreen: (point) => point,
      viewportToPage: (point) => point,
      selectionEdgeDrag: edge.port,
      start: {
        additive: false,
        kind: "element-move",
        tool: "select",
        pointer: { pointerId: 1, pointerType: "pen", x: 21, y: 21 },
      },
    });
    const apply = vi.spyOn(SceneContentRenderer.prototype, "applyPreviewTransform");
    const geometry = vi.spyOn(CanonicalElementPathPreparation.prototype, "step");
    const read = vi.spyOn(store, "get");
    scene.renderer.resetInstrumentation();
    try {
      for (const x of [29, 33, 37]) {
        preview.update({ pointerId: 1, pointerType: "pen", x, y: 21 });
        frames.runNext();
        expect(apply.mock.calls.length % count).toBe(0);
        const writes = scene.renderer.instrumentation().attributeWrites;
        const applications = apply.mock.calls.length;
        frames.runNext();
        scene.scheduler.runAll();
        expect(apply).toHaveBeenCalledTimes(applications);
        expect(scene.renderer.instrumentation().attributeWrites).toBe(writes);
        for (const node of scene.selectedNodes)
          expect(node.attributes.get("transform")).toBe(`translate(${x - 21} 0)`);
      }
      expect(apply).toHaveBeenCalledTimes(count * 3);
      expect(geometry).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(scroll).not.toHaveBeenCalled();
      preview.revert();
      expect(frames.pendingCount).toBe(0);
      scene.scheduler.runAll();
      for (const node of scene.selectedNodes) expect(node.attributes.has("transform")).toBe(false);
    } finally {
      preview.revert();
      apply.mockRestore();
      geometry.mockRestore();
      read.mockRestore();
      scene.renderer.destroy();
      sceneStore.release();
    }
  },
);
describe("mounted preview candidate work", () => {
  it("reuses actual scene membership without another query of a 10000-element selection", () => {
    const elements = Array.from(
      { length: 10000 },
      (_, index) =>
        fakeRectangleRecord(
          `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          index,
          (index % 100) * 1000,
          Math.floor(index / 100) * 1000,
        ).element,
    );
    const store = new ElementStore(elements);
    const port = new ElementSceneStore(store);
    const { renderer, scheduler } = createSceneFixture(createAllElementSnapshot().page, port, {
      height: 100,
      left: 0,
      top: 0,
      width: 100,
    });
    scheduler.runAll();
    const get = vi.spyOn(port, "get");
    const query = vi.spyOn(port, "query");
    const previews = new SceneElementPreviews(
      {
        previewMemoryUsage: () => 0,
        previewMountedIds: () => renderer.mountedIds("content"),
      } as unknown as SceneContentRenderer,
      port,
    );
    const ids = elements.map(({ id }) => id);
    try {
      for (const index of [0, 5000, 9999]) {
        const viewport = { height: 100, left: 0, top: Math.floor(index / 100) * 1000, width: 100 };
        const camera = { x: -(index % 100) * 1000, zoom: 1 };
        renderer.setViewport(viewport);
        renderer.setCamera(camera);
        scheduler.runAll();
        get.mockClear();
        query.mockClear();
        store.resetInstrumentation();
        const selected = previews.selectProgressiveIds(ids, viewport, camera);
        expect(selected).toContain(ids[index]);
        expect(selected).toHaveLength(renderer.mountedCount);
        expect(get).not.toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();
        expect(previews.selectProgressiveIds(ids, viewport, camera)).toBe(selected);
        expect(store.instrumentation.fullStoreScans).toBe(0);
        expect(previews.memoryUsage()).toBe(10000 * 112 + selected.length * 8);
      }
      previews.clearProgressive();
      expect(previews.memoryUsage()).toBe(0);
    } finally {
      previews.release();
      renderer.destroy();
      port.release();
    }
  });

  it("keeps complete dense feedback separate from bounded canonical snapshot materialization", () => {
    const fixture = createDenseSelectionPreview(300);
    const { renderer, scheduler, ids, selectedNodes, store } = fixture;
    const materialize = vi.fn((id: string) => store.get(id)?.element);
    const query = vi.spyOn(store, "query");
    try {
      renderer.setProgressiveElementPreviews(ids, materialize, 1, {
        transform: "scale(2 1)",
        inverse: "scale(0.5 1)",
      });
      renderer.flushPointerFeedbackFrame(scheduler.time);
      expect(materialize).not.toHaveBeenCalled();
      expect(selectedNodes.every((node) => node.attributes.get("transform") === "scale(2 1)")).toBe(
        true,
      );
      scheduler.runAll();
      expect(new Set(materialize.mock.calls.map(([id]) => id)).size).toBeLessThanOrEqual(256);
      expect(query).not.toHaveBeenCalled();
      materialize.mockClear();
      renderer.clearProgressiveElementPreviews();
      scheduler.runAll();
      expect(materialize).not.toHaveBeenCalled();
      expect(selectedNodes.every((node) => !node.attributes.has("transform"))).toBe(true);
    } finally {
      renderer.destroy();
    }
  });
});
