import { afterEach, describe, expect, it, vi } from "vitest";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { strokeLocalGeometry } from "../../../../src/domain/geometry/stroke-position";
import { ProgressivePreviewPath } from "../../../../src/rendering/scene/progressive-preview-path";
import {
  createProgressivePreviewFixture,
  observePressurePreviewSteps,
  writeOnePreviewStep,
} from "../../../fixtures/rendering/progressive-element-preview";
import { createMultiWindowPressureStroke } from "../../../fixtures/persistence/worker-snapshot";
import { ElementStore } from "../../../../src/domain/store/public";
import { takeImmutableElementOwnership } from "../../../../src/domain/store/immutability";
import type { StrokeElementV1 } from "../../../../src/domain/schema/public";

afterEach(() => vi.restoreAllMocks());

describe("pressure snapshot immutable shape ownership", () => {
  it.each(["header", "style", "pressure", "pivot", "offset"] as const)(
    "cancels a suspended path after in-place mutation of an unfrozen %s",
    (mutable) => {
      const { content, preview } = createProgressivePreviewFixture();
      const element = {
        ...createMultiWindowPressureStroke(),
        rotation: 37,
        offset: { x: 0, y: 0 },
      };
      Object.freeze(element.points);
      if (mutable !== "style" && mutable !== "pressure") Object.freeze(element.style);
      if (mutable !== "pivot") Object.freeze(element.pivot);
      if (mutable !== "offset") Object.freeze(element.offset);
      if (mutable !== "header") Object.freeze(element);
      const request = {
        ids: [element.id],
        materialize: () => element,
        feedback: { transform: "scale(2 1)", inverse: "scale(0.5 1)" },
      };
      const { steps, windows, writeNext } = observePressurePreviewSteps();
      preview.set({ ...request, version: 1 });
      while (windows.mock.calls.length === 0) writeNext(preview);
      const oldPath = steps.mock.contexts[0] as ProgressivePreviewPath;
      const cancel = vi.spyOn(oldPath, "cancel");
      if (mutable === "header") element.rotation = 27;
      if (mutable === "style") expect(Reflect.set(element.style, "width", 4)).toBe(true);
      if (mutable === "pressure")
        expect(Reflect.set(element.style, "pressureEnabled", false)).toBe(true);
      if (mutable === "pivot") element.pivot.x += 5;
      if (mutable === "offset") element.offset.x += 5;
      preview.set({ ...request, version: 2 });
      writeNext(preview);
      expect(cancel).toHaveBeenCalledOnce();
      expect(oldPath.memoryUsage()).toBe(0);
      expect(content.applyCanonicalElementPreview).not.toHaveBeenCalled();
      steps.mockRestore();
      expect(oldPath.step()).toBe(false);
      expect(preview.write(Infinity, () => 0)).toBe(false);
      expect(content.applyCanonicalElementPreview).toHaveBeenCalledExactlyOnceWith(
        element,
        buildElementPathParts(strokeLocalGeometry(element)),
      );
      preview.clear();
      expect(preview.memoryUsage()).toBe(0);
    },
  );
});

it.each(["stored", "frozen"] as const)(
  "reuses a complete immutable %s shape with an offset",
  (ownership) => {
    const { content, preview } = createProgressivePreviewFixture();
    const source = { ...createMultiWindowPressureStroke(), offset: { x: 5, y: 7 } };
    const store = ownership === "stored" ? new ElementStore([source]) : undefined;
    takeImmutableElementOwnership(source);
    const element = (store?.get(source.id)?.element ?? source) as StrokeElementV1;
    const request = {
      ids: [source.id],
      materialize: () => element,
      feedback: { transform: "scale(2 1)", inverse: "scale(0.5 1)" },
    };
    const cancel = vi.spyOn(ProgressivePreviewPath.prototype, "cancel");
    preview.set({ ...request, version: 1 });
    writeOnePreviewStep(preview);
    preview.set({ ...request, version: 2 });
    writeOnePreviewStep(preview);
    expect(cancel).not.toHaveBeenCalled();
    expect(preview.write(Infinity, () => 0)).toBe(false);
    expect(content.applyCanonicalElementPreview).toHaveBeenCalledOnce();
    preview.clear();
    store?.releasePreparedPressureGeometry();
    expect(preview.memoryUsage()).toBe(0);
  },
);
