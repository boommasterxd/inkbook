import { describe, expect, it, vi } from "vitest";
import { SceneTransformPreviewController } from "../../../../src/rendering/scene/transform-preview-controller";

function createController() {
  const applyPreviewTransform = vi.fn();
  const controller = new SceneTransformPreviewController(
    {
      applyPreviewTransform,
      flushSelectionContext: vi.fn(),
      promoteVisible: vi.fn(() => false),
      previewMountedIds: () => [],
    },
    { x: 0, zoom: 1 },
  );
  return { controller, applyPreviewTransform };
}

describe("transform preview ownership", () => {
  it("releases reset transforms across disjoint gestures and performs no historical clear work", () => {
    const { controller, applyPreviewTransform } = createController();
    for (const id of ["first", "second", "third"]) {
      controller.set([id], "translate(1 1)", 1, "scale");
      expect(controller.memoryUsage()).toBeGreaterThan(0);
      controller.write();
      controller.clear();
      expect(controller.memoryUsage()).toBeGreaterThan(0);
      controller.write();
      expect(controller.values.size).toBe(0);
      expect(controller.memoryUsage()).toBe(0);
    }
    expect(applyPreviewTransform).toHaveBeenCalledTimes(6);
    controller.clear();
    controller.write();
    expect(applyPreviewTransform).toHaveBeenCalledTimes(6);
  });

  it("applies current feedback to newly mounted selected ids without rewriting old roots", () => {
    const { controller, applyPreviewTransform } = createController();
    const ids = Array.from({ length: 300 }, (_, index) => String(index));
    controller.set(ids, "rotate(30 0 0)", 1, "scale");
    controller.applyMounted(["299", "unselected"]);
    expect(applyPreviewTransform).toHaveBeenCalledExactlyOnceWith("299", "rotate(30 0 0)", 1, null);
    controller.applyMounted(["299"]);
    expect(applyPreviewTransform).toHaveBeenCalledOnce();
    controller.clear();
    controller.write();
    expect(controller.memoryUsage()).toBe(0);
    expect(controller.values.size).toBe(0);
  });
});
