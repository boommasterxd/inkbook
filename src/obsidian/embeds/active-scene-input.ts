import type { SvgSceneRenderer } from "../../rendering/scene/index";

import type { ActiveEditorController } from "./active-editor/controller";

export function attachActiveSceneInputListeners(
  renderer: SvgSceneRenderer,
  controller: ActiveEditorController,
): () => void {
  const lostCapture = (event: PointerEvent): void => controller.handleLostPointerCapture(event);
  const paste = (event: ClipboardEvent): void => {
    if (controller.handlePaste(event.clipboardData)) event.preventDefault();
  };
  const pointerEnter = (): void => controller.handlePointerBoundary(true);
  const pointerLeave = (): void => controller.handlePointerBoundary(false);
  const ownerDocument = renderer.inputSurface.ownerDocument;
  const hoverZoom = (event: KeyboardEvent): void => {
    if (!isWithinSurface(renderer.inputSurface, event.target)) {
      controller.handleHoverZoomKeyDown(event);
    }
  };
  renderer.inputSurface.addEventListener("lostpointercapture", lostCapture);
  renderer.inputSurface.addEventListener("paste", paste);
  renderer.inputSurface.addEventListener("pointerenter", pointerEnter);
  renderer.inputSurface.addEventListener("pointerleave", pointerLeave);
  ownerDocument.addEventListener("keydown", hoverZoom);
  return () => {
    renderer.inputSurface.removeEventListener("lostpointercapture", lostCapture);
    renderer.inputSurface.removeEventListener("paste", paste);
    renderer.inputSurface.removeEventListener("pointerenter", pointerEnter);
    renderer.inputSurface.removeEventListener("pointerleave", pointerLeave);
    ownerDocument.removeEventListener("keydown", hoverZoom);
  };
}

function isWithinSurface(surface: HTMLElement, target: EventTarget | null): boolean {
  return target !== null && "nodeType" in target && surface.contains(target as Node);
}
