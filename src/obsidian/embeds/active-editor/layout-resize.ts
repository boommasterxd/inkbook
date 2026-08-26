import { applyResize, type ScrollBounds } from "../../../editor/zoom/index";

export interface ActiveEditorResizeAnchor {
  readonly anchorViewportY: number;
  readonly embedTopInScrollContent: number;
  readonly oldCameraX: number;
  readonly oldRenderedContainerHeight: number;
  readonly oldScrollTop: number;
  readonly scrollBounds: ScrollBounds;
  readonly viewportWidth: number;
}

export interface ActiveEditorResizeUpdate {
  readonly cameraX: number;
  readonly fitZoom: number;
  readonly scrollTop?: number;
  readonly zoom: number;
}

interface ActiveEditorResizeCalculation extends ActiveEditorResizeUpdate {
  readonly renderedContainerHeight: number;
  readonly scrollTop: number;
}

interface ActiveEditorResizeInput {
  readonly anchor: ActiveEditorResizeAnchor;
  readonly fitZoom: number;
  readonly oldFitZoom: number;
  readonly oldZoom: number;
  readonly pageHeight: number;
  readonly width: number;
}

export function calculateActiveEditorResize(
  input: ActiveEditorResizeInput,
): ActiveEditorResizeCalculation {
  const resized = applyResize({
    ...input.anchor,
    containerWidth: input.width,
    derivedPageHeight: input.pageHeight,
    newFitZoom: input.fitZoom,
    oldFitZoom: input.oldFitZoom,
    oldZoom: input.oldZoom,
  });
  return {
    cameraX: resized.camera.x,
    fitZoom: input.fitZoom,
    renderedContainerHeight: resized.renderedContainerHeight,
    scrollTop: resized.scrollTop,
    zoom: resized.camera.zoom,
  };
}
