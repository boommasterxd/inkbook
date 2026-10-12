import { vi } from "vitest";
import type { InkElementV1 } from "../../../src/domain/schema/public";
import type { SvgPathPart } from "../../../src/domain/geometry/element-path";
import type { SceneContentRenderer } from "../../../src/rendering/scene/content-renderer";
import { ProgressiveElementPreview } from "../../../src/rendering/scene/progressive-element-preview";
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
