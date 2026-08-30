import type { SvgSceneRenderer } from "../../rendering/scene/index";

import type { ActiveEditorController } from "./active-editor/controller";
import { CanvasTouchBoundary } from "./canvas-touch-boundary";

export function attachActiveSceneInputListeners(
  renderer: SvgSceneRenderer,
  controller: ActiveEditorController,
): () => void {
  const touchBoundary = new CanvasTouchBoundary(renderer.inputSurface, {
    onPrimaryTouchStart: () => controller.preparePrimaryTouchStart(),
    onTouchInterrupted: () => controller.recoverInterruptedTouch(),
    onTouchPointerMove: (event) => controller.handlePointerMove(event),
    onTouchPointerStart: (event) => controller.handlePointerDown(event),
    onTouchTerminal: (pointerId) => controller.recoverTouchTerminal(pointerId),
    shouldBlockTouchEvent: () => controller.blocksNativeTouchScrolling(),
  });
  const lostCapture = (event: PointerEvent): void => controller.handleLostPointerCapture(event);
  const paste = (event: ClipboardEvent): void => {
    if (controller.handlePaste(event.clipboardData)) event.preventDefault();
  };
  const pointerEnter = (): void => controller.handlePointerBoundary(true);
  const pointerLeave = (): void => controller.handlePointerBoundary(false);
  const ownerDocument = renderer.inputSurface.ownerDocument;
  const documentKeyDown = (event: KeyboardEvent): void => {
    if (
      !isWithinSurface(renderer.inputSurface, event.target) &&
      controller.handleDocumentKeyDown(event)
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const documentPaste = (event: ClipboardEvent): void => {
    if (
      !isWithinSurface(renderer.inputSurface, event.target) &&
      controller.handlePaste(event.clipboardData)
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  renderer.inputSurface.addEventListener("lostpointercapture", lostCapture);
  renderer.inputSurface.addEventListener("paste", paste);
  renderer.inputSurface.addEventListener("pointerenter", pointerEnter);
  renderer.inputSurface.addEventListener("pointerleave", pointerLeave);
  ownerDocument.addEventListener("keydown", documentKeyDown, true);
  ownerDocument.addEventListener("paste", documentPaste, true);
  return () => {
    touchBoundary.dispose();
    renderer.inputSurface.removeEventListener("lostpointercapture", lostCapture);
    renderer.inputSurface.removeEventListener("paste", paste);
    renderer.inputSurface.removeEventListener("pointerenter", pointerEnter);
    renderer.inputSurface.removeEventListener("pointerleave", pointerLeave);
    ownerDocument.removeEventListener("keydown", documentKeyDown, true);
    ownerDocument.removeEventListener("paste", documentPaste, true);
  };
}

function isWithinSurface(surface: HTMLElement, target: EventTarget | null): boolean {
  return target !== null && "nodeType" in target && surface.contains(target as Node);
}
