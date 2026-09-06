import { describe, expect, it, vi } from "vitest";

import type { SceneContentRenderer } from "../../../../src/rendering/scene/content-renderer";
import { SceneElementPreviewController } from "../../../../src/rendering/scene/element-preview-controller";
import { SceneTransformPreviewController } from "../../../../src/rendering/scene/transform-preview-controller";
import type { SceneStorePort } from "../../../../src/rendering/scene/types";

import { fakeRectangleRecord } from "./fakes";

describe("scene preview controller regressions", () => {
  it("does not rebuild a stable transform selection on every pointer frame", () => {
    const record = fakeRectangleRecord("shape", 0, 10);
    const get = vi.fn((id: string) => (id === record.id ? record : undefined));
    const content = {
      applyPreviewTransform: vi.fn(),
      promoteVisible: vi.fn(() => false),
    } as unknown as SceneContentRenderer;
    const controller = new SceneTransformPreviewController(
      content,
      { get, query: vi.fn() } satisfies SceneStorePort,
      { x: 0, zoom: 1 },
    );
    const ids = [record.id];

    controller.set(ids, "translate(1 0)", 1, "scale");
    controller.set(ids, "translate(2 0)", 2, "scale");

    expect(get).toHaveBeenCalledOnce();
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
    controller.write([]);
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

    controller.write([]);
    expect(applyElementPreview).toHaveBeenCalledOnce();
    expect(applyElementPreview).toHaveBeenCalledWith(latest[0], false);
  });

  it("does not rebuild an unchanged stable fallback mixed with a changing preview", () => {
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
    controller.write([]);
    controller.set([stable, { ...changing, width: 80 }], 2);
    controller.write([]);

    expect(applyElementPreview).toHaveBeenCalledTimes(3);
    expect(applyElementPreview).toHaveBeenLastCalledWith({ ...changing, width: 80 }, false);
  });
});
