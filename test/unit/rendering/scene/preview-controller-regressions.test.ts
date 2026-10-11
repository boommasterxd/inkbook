import { describe, expect, it, vi } from "vitest";

import type { SceneContentRenderer } from "../../../../src/rendering/scene/content-renderer";
import { SceneElementPreviewController } from "../../../../src/rendering/scene/element-preview-controller";
import { SceneElementPreviews } from "../../../../src/rendering/scene/scene-element-previews";
import { SceneTransformPreviewController } from "../../../../src/rendering/scene/transform-preview-controller";

import { FakeSceneStore, fakeRectangleRecord } from "./fakes";

describe("progressive scene preview candidate selection", () => {
  it("refreshes bounded progressive candidates on viewport changes and stops after clear", () => {
    const records = Array.from({ length: 257 }, (_, index) =>
      fakeRectangleRecord(String(index), index, index * 10),
    );
    const store = new FakeSceneStore();
    let mounted = ["0"];
    for (const record of records) store.records.set(record.id, record);
    const previews = new SceneElementPreviews(
      {
        promoteVisible: vi.fn(),
        previewMountedIds: () => mounted,
      } as unknown as SceneContentRenderer,
      store,
    );
    const set = vi.spyOn(previews.progressive, "set");
    const materialize = vi.fn();
    const viewport = { height: 100, left: 0, top: 0, width: 100 };
    previews.setProgressive(
      { ids: records.map(({ id }) => id), materialize, version: 1 },
      viewport,
      {
        x: 0,
        zoom: 1,
      },
    );
    expect(set.mock.lastCall?.[0].ids).not.toContain("256");
    mounted = ["0", "256"];
    previews.refreshProgressiveContext(viewport, { x: -2560, zoom: 1 });
    expect(set.mock.lastCall?.[0].ids).toContain("256");
    expect(set.mock.lastCall?.[0].ids.length).toBeLessThanOrEqual(256);
    expect(set.mock.lastCall?.[0].ids).toContain("0");
    expect(materialize).not.toHaveBeenCalled();
    previews.clearProgressive();
    previews.refreshProgressiveContext(viewport, { x: 0, zoom: 1 });
    expect(set).toHaveBeenCalledTimes(2);
  });

  it("reuses progressive viewport candidates until the selection or camera context changes", () => {
    const record = fakeRectangleRecord("shape", 0, 10);
    const get = vi.fn(() => record);
    const previews = new SceneElementPreviews(
      { previewMountedIds: () => [record.id] } as unknown as SceneContentRenderer,
      {
        get,
        query: vi.fn(),
      },
    );
    const ids = [record.id];
    const camera = { x: 0, zoom: 1 };
    const selected = previews.selectProgressiveIds(ids, undefined, camera);
    expect(previews.selectProgressiveIds(ids, undefined, camera)).toBe(selected);
    expect(get).not.toHaveBeenCalled();

    const moved = { x: 20, zoom: 1 };
    previews.selectProgressiveIds(ids, undefined, moved);
    expect(get).not.toHaveBeenCalled();
    previews.release();
    previews.selectProgressiveIds(ids, undefined, moved);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("scene preview controller regressions", () => {
  it("does not rebuild a stable transform selection on every pointer frame", () => {
    const record = fakeRectangleRecord("shape", 0, 10);
    const get = vi.fn((id: string) => (id === record.id ? record : undefined));
    const content = {
      applyPreviewTransform: vi.fn(),
      promoteVisible: vi.fn(() => false),
      previewMountedIds: () => [record.id],
    } as unknown as SceneContentRenderer;
    const controller = new SceneTransformPreviewController(content, { x: 0, zoom: 1 });
    const ids = [record.id];

    controller.set(ids, "translate(1 0)", 1, "scale");
    controller.set(ids, "translate(2 0)", 2, "scale");

    expect(get).not.toHaveBeenCalled();
  });

  it("reuses stable pressure fallback geometry and checks only newly mounted ids", () => {
    const record = fakeRectangleRecord("shape", 0, 10);
    const applyElementPreview = vi.fn(() => true);
    const promoteVisible = vi.fn(() => false);
    const content = {
      applyElementPreview,
      clearElementPreview: vi.fn(),
      promoteVisible,
    } as unknown as SceneContentRenderer;
    const controller = new SceneElementPreviewController(content);
    const elements = [record.element];

    controller.set(elements, 1);
    controller.set(elements, 2);
    controller.write();
    controller.applyMounted([record.id, "unrelated"]);

    expect(applyElementPreview).toHaveBeenCalledTimes(2);
    expect(promoteVisible).toHaveBeenCalledOnce();
  });

  it("replaces staged exact geometry before writing the input frame", () => {
    const record = fakeRectangleRecord("shape", 0, 10);
    const applyElementPreview = vi.fn();
    const controller = new SceneElementPreviewController({
      applyElementPreview,
      clearElementPreview: vi.fn(),
      promoteVisible: vi.fn(() => false),
    } as unknown as SceneContentRenderer);
    const first = [{ ...record.element, width: 20 }];
    const latest = [{ ...record.element, width: 30 }];

    controller.set(first, 1);
    controller.set(latest, 2);
    expect(applyElementPreview).not.toHaveBeenCalled();

    controller.write();
    expect(applyElementPreview).toHaveBeenCalledOnce();
    expect(applyElementPreview).toHaveBeenCalledWith(latest[0]);
  });

  it("does not rebuild an unchanged canonical element mixed with a changing preview", () => {
    const stable = fakeRectangleRecord("stable", 0, 10).element;
    const changing = fakeRectangleRecord("changing", 1, 40).element;
    if (changing.kind !== "rectangle") throw new TypeError("Expected a rectangle.");
    const applyElementPreview = vi.fn();
    const controller = new SceneElementPreviewController({
      applyElementPreview,
      clearElementPreview: vi.fn(),
      promoteVisible: vi.fn(() => false),
    } as unknown as SceneContentRenderer);

    controller.set([stable, changing], 1);
    controller.write();
    controller.set([stable, { ...changing, width: 80 }], 2);
    controller.write();

    expect(applyElementPreview).toHaveBeenCalledTimes(3);
    expect(applyElementPreview).toHaveBeenLastCalledWith({ ...changing, width: 80 });
  });
});

describe("transformed preview candidate retention", () => {
  it("retains translated preview roots when their source leaves the camera neighborhood", () => {
    const store = new FakeSceneStore();
    const ids = Array.from({ length: 300 }, (_, index) => String(index));
    for (const id of ids) store.records.set(id, fakeRectangleRecord(id, 0, Number(id) * 1000));
    const applyPreviewTransform = vi.fn();
    const controller = new SceneTransformPreviewController(
      {
        applyPreviewTransform,
        flushSelectionContext: vi.fn(),
        promoteVisible: vi.fn(),
        previewMountedIds: () => ["0", "1"],
      } as unknown as SceneContentRenderer,
      { x: 0, zoom: 1 },
    );
    const viewport = { height: 100, left: 0, top: 0, width: 100 };
    controller.setContext({ x: 0, zoom: 1 }, viewport);
    controller.set(ids, "translate(1000 0)", 1, "scale");
    controller.setContext({ x: -1000, zoom: 1 }, viewport);
    controller.refreshContext();
    controller.write();
    expect(controller.activeIds).toContain("0");
    expect(applyPreviewTransform).toHaveBeenCalledWith("0", "translate(1000 0)", 1, null);
    controller.clear();
    controller.write();
    expect(applyPreviewTransform).toHaveBeenCalledWith("0", null, Number.MAX_SAFE_INTEGER, null);
    controller.release();
    expect(controller.values.size).toBe(0);
  });
});
