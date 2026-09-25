import { vi } from "vitest";

/** Renderer boundary for selection previews that do not mount an SVG scene. */
export function createSelectionPreviewRenderer() {
  return {
    clearPreviewTransforms: vi.fn(),
    setOverlayPath: vi.fn(),
    setPreviewTransform: vi.fn(),
    suppressMotionForNextDelta: vi.fn(),
  };
}
