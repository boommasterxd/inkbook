import { expect, it, vi } from "vitest";
import type { SceneContentRenderer } from "../../../../../src/rendering/scene/content-renderer";
import { ProgressiveElementPreview } from "../../../../../src/rendering/scene/presentation/progressive-element-preview";
import { createProgressivePreviewFixture } from "../../../../fixtures/rendering/progressive-element-preview";
import { textElement } from "../../../../fixtures/rendering/text";

it("retains the old text feedback basis until the prepared glyph tree is published", () => {
  const { content: base } = createProgressivePreviewFixture();
  const canonical = textElement();
  const target = { ...canonical, style: { ...canonical.style, fontSize: 48 } };
  const mounted = { element: canonical };
  const basis = vi.fn();
  const content = {
    ...base,
    mountedText: () => mounted,
    setSelectionFeedbackBasis: basis,
  };
  const preview = new ProgressiveElementPreview(content as unknown as SceneContentRenderer);
  const feedback = { transform: "scale(2 1)", inverse: "scale(0.5 1)" };
  preview.set({ ids: [target.id], materialize: () => target, version: 1, feedback });
  expect(preview.write(Infinity, () => 0)).toBe(false);
  expect(content.applyCanonicalElementPreview).toHaveBeenCalledOnce();
  expect(basis).not.toHaveBeenCalled();
  mounted.element = target;
  preview.applyMounted([target.id]);
  expect(basis).toHaveBeenCalledWith(target.id, feedback);
  expect(content.applyPreviewTransform).toHaveBeenCalledWith(target.id, null, 1, null);
});
