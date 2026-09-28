import type { Component } from "obsidian";

const CANVAS_TOUCH_START = "inkbook-canvas-touch-start";

/** Let owned menus observe touch before the canvas stops host propagation. */
export function dismissMenuForCanvasTouch(document: Document, pointer: PointerEvent): boolean {
  const eventConstructor = document.defaultView?.CustomEvent ?? CustomEvent;
  const notice = new eventConstructor<PointerEvent>(CANVAS_TOUCH_START, {
    cancelable: true,
    detail: pointer,
  });
  return !document.dispatchEvent(notice);
}

export function registerMenuPointerDismissal(
  owner: Component,
  document: Document,
  handlePointer: (event: PointerEvent) => void,
): void {
  owner.registerDomEvent(document, "pointerdown", handlePointer, true);
  const forwarded = (event: Event): void => {
    const pointer = (event as CustomEvent<PointerEvent>).detail;
    handlePointer(pointer);
    if (pointer.defaultPrevented) event.preventDefault();
  };
  document.addEventListener(CANVAS_TOUCH_START, forwarded);
  owner.register(() => document.removeEventListener(CANVAS_TOUCH_START, forwarded));
}
