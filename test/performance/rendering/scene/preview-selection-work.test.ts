import { describe, expect, it, vi } from "vitest";
import { ElementStore } from "../../../../src/domain/store/public";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import { SceneElementPreviews } from "../../../../src/rendering/scene/scene-element-previews";
import type { SceneContentRenderer } from "../../../../src/rendering/scene/content-renderer";
import { createAllElementSnapshot } from "../../../unit/persistence/serialization/fixtures";
import { fakeRectangleRecord } from "../../../unit/rendering/scene/fakes";
import { createSceneFixture } from "../../../fixtures/rendering/scene";
import { createDenseSelectionPreview } from "../../../fixtures/rendering/selection-preview";
import { ProgressivePreviewPath } from "../../../../src/rendering/scene/progressive-preview-path";

describe("progressive snapshot ownership", () => {
  it("retains the same unfinished snapshot across superseding feedback and releases it on cancel", () => {
    const { renderer, scheduler, ids, store } = createDenseSelectionPreview(300);
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
      }
      expect(paths.size).toBe(1);
      expect(materialize).toHaveBeenCalledOnce();
      renderer.clearProgressiveElementPreviews();
      scheduler.runAll();
      expect(cancel).toHaveBeenCalledOnce();
      expect(materialize).toHaveBeenCalledOnce();
    } finally {
      step.mockRestore();
      cancel.mockRestore();
      renderer.destroy();
    }
  });
});
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
