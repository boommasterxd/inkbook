import type { CreationPreviewRenderer } from "../../../src/obsidian/embeds/active-editor/creation-preview";

export function creationPreviewRenderer(
  overrides: Partial<CreationPreviewRenderer> = {},
): CreationPreviewRenderer {
  return {
    clearLiveStroke: () => undefined,
    revertLiveStroke: () => undefined,
    setLivePath: () => undefined,
    setSnapMarkerPath: () => undefined,
    suppressMotionForNextDelta: () => undefined,
    updateLiveStroke: () => undefined,
    ...overrides,
  };
}

export interface RectFixture {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

export function domRect(rect: RectFixture): DOMRect {
  return {
    bottom: rect.top + rect.height,
    height: rect.height,
    left: rect.left,
    right: rect.left + rect.width,
    top: rect.top,
    width: rect.width,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  };
}
