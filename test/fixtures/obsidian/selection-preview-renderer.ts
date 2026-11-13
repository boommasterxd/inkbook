import { vi } from "vitest";
import type { HandleInteractionRenderer } from "../../../src/obsidian/embeds/active-editor/previews/handle-presentation";

/** Renderer boundary for selection previews that do not mount an SVG scene. */
export function createSelectionPreviewRenderer() {
  return {
    clearPreviewTransforms: vi.fn(),
    setOverlayPath: vi.fn(),
    setPreviewTransform: vi.fn(),
    suppressMotionForNextDelta: vi.fn(),
  };
}

/** Shared observed boundary for exact element and selection-handle previews. */
export function createHandlePreviewRenderer() {
  return {
    ...createSelectionPreviewRenderer(),
    clearElementPreviews: vi.fn(),
    flushPointerFeedbackFrame: vi.fn(),
    setElementPreviews: vi.fn<HandleInteractionRenderer["setElementPreviews"]>(),
    setSelectionOverlayPath: vi.fn<HandleInteractionRenderer["setSelectionOverlayPath"]>(),
    setSnapMarkerPath: vi.fn(),
  };
}
