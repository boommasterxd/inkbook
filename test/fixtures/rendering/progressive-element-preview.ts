import { vi } from "vitest";
import type { InkElementV1 } from "../../../src/domain/schema/public";
import type { SvgPathPart } from "../../../src/domain/geometry/element-path";
import type { SceneContentRenderer } from "../../../src/rendering/scene/content-renderer";
import { ProgressiveElementPreview } from "../../../src/rendering/scene/progressive-element-preview";
import { ProgressivePreviewPath } from "../../../src/rendering/scene/progressive-preview-path";
import * as pressureWindows from "../../../src/domain/geometry/pressure-window";
import { indexedStroke } from "../editor/stroke";

export function createProgressivePreviewFixture(maximumBytes?: number) {
  const content = {
    applyCanonicalElementPreview: vi.fn(
      (_element: InkElementV1, _parts: readonly SvgPathPart[]) => true,
    ),
    clearElementPreview: vi.fn(),
    applyPreviewTransform: vi.fn<SceneContentRenderer["applyPreviewTransform"]>(),
    promoteVisible: vi.fn(),
  };
  return {
    content,
    preview: new ProgressiveElementPreview(
      content as unknown as SceneContentRenderer,
      maximumBytes,
    ),
  };
}

export function createLongPreviewStroke(index: number) {
  return {
    ...indexedStroke(index),
    points: Array.from({ length: 4096 }, (_, offset) => [offset, offset % 2, 0.5]).flat(),
  };
}

export function writeOnePreviewStep(preview: ProgressiveElementPreview): void {
  let time = 0;
  preview.write(1, () => time++);
}

export function observePressurePreviewSteps() {
  let time = 0;
  const step = Reflect.get(ProgressivePreviewPath.prototype, "step");
  const steps = vi.spyOn(ProgressivePreviewPath.prototype, "step");
  steps.mockImplementation(function (this: ProgressivePreviewPath) {
    const complete = step.call(this, 0, () => 1);
    time += 1;
    return complete;
  });
  return {
    steps,
    windows: vi.spyOn(pressureWindows, "preparePressureWindowSteps"),
    writeNext: (preview: ProgressiveElementPreview) => preview.write(time + 1, () => time),
  };
}
