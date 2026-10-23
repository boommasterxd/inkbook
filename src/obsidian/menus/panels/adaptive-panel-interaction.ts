import { Component, Platform } from "obsidian";

import { registerMenuPointerDismissal } from "../menu-pointer-dismissal";
import { trapPhoneSheetFocus } from "./phone-sheet-focus";
import type { PhoneSheetSwipeController } from "./phone-sheet-swipe";
import type { AdaptivePanelPlacement } from "./adaptive-panel-placement";

interface PanelInteractionOptions {
  readonly owner: Component;
  readonly ownerDocument: Document;
  readonly surface: HTMLElement;
  readonly scroll: HTMLElement;
  readonly anchor: HTMLElement;
  readonly initialFocus?: HTMLElement;
  readonly dismissOnAnchorPointer: boolean;
  readonly swipe?: PhoneSheetSwipeController;
  readonly topmost: () => boolean;
  readonly focusable: () => HTMLElement[];
  readonly backOrClose: () => void;
  readonly close: () => void;
}

/** Lifecycle-owned keyboard, pointer, and phone swipe input for one panel. */
export function registerPanelInteraction(options: PanelInteractionOptions): void {
  const { owner, ownerDocument, surface, scroll, swipe } = options;
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || !options.topmost()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      options.backOrClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = options.focusable();
    if (focusable.length === 0) return;
    const index = focusable.indexOf(ownerDocument.activeElement as HTMLElement);
    const next = event.shiftKey
      ? focusable[(index <= 0 ? focusable.length : index) - 1]
      : focusable[(index + 1) % focusable.length];
    event.preventDefault();
    next?.focus({ preventScroll: true });
  };
  const onOutsidePointer = (event: PointerEvent): void => {
    if (!options.topmost()) return;
    const target = event.target;
    if (target === null || !("nodeType" in target)) return;
    if (
      surface.contains(target as Node) ||
      (!options.dismissOnAnchorPointer && options.anchor.contains(target as Node))
    )
      return;
    if (event.pointerType === "touch") {
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
    }
    options.close();
  };
  if (Platform.isPhone) {
    owner.register(trapPhoneSheetFocus(surface, options.initialFocus ?? surface, options.topmost));
  }
  owner.registerDomEvent(ownerDocument, "keydown", onKeyDown, true);
  registerMenuPointerDismissal(owner, ownerDocument, onOutsidePointer);
  if (swipe === undefined) return;
  owner.registerDomEvent(surface, "pointerdown", swipe.handlePointerDown);
  owner.registerDomEvent(surface, "pointermove", swipe.handlePointerMove);
  owner.registerDomEvent(surface, "pointerup", swipe.handlePointerUp);
  owner.registerDomEvent(surface, "pointercancel", swipe.handlePointerCancel);
  owner.registerDomEvent(surface, "lostpointercapture", swipe.handleLostPointerCapture);
  owner.registerDomEvent(scroll, "scroll", swipe.syncScrollPosition);
  owner.register(() => swipe.dispose());
}

interface PanelViewportOptions {
  readonly owner: Component;
  readonly ownerWindow: Window;
  readonly ownerDocument: Document;
  readonly surface: HTMLElement;
  readonly placement: AdaptivePanelPlacement;
  readonly reposition: (revealEditable?: boolean) => void;
}

/** Owning-window and visual viewport listeners keep phone sheets above the keyboard. */
export function registerPanelViewport(options: PanelViewportOptions): void {
  const { owner, ownerWindow, ownerDocument, surface, placement } = options;
  const reveal = (): void => options.reposition(true);
  owner.register(placement.observeKeyboard(reveal));
  const onScroll = (event: Event): void => {
    const target = event.target;
    if (target !== null && "nodeType" in target && surface.contains(target as Node)) return;
    options.reposition();
  };
  owner.registerDomEvent(ownerWindow, "resize", reveal);
  owner.registerDomEvent(ownerDocument, "scroll", onScroll, true);
  const viewport = ownerWindow.visualViewport;
  if (viewport === undefined || viewport === null) return;
  viewport.addEventListener("resize", reveal);
  viewport.addEventListener("scroll", reveal);
  owner.register(() => {
    viewport.removeEventListener("resize", reveal);
    viewport.removeEventListener("scroll", reveal);
  });
}
