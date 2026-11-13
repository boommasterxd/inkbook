import { Component, Platform } from "obsidian";
import { cycleModalFocus, registerFocusNavigation } from "../../runtime/focus-navigation";

import { registerMenuPointerDismissal } from "../menu-pointer-dismissal";
import { containsOwnedMenuTarget } from "../owned-menu-target";
import {
  isExternalPanelFocus,
  trapPhoneSheetFocus,
  type ExternalPanelFocusTarget,
} from "./phone-sheet-focus";
import type { PhoneSheetSwipeController } from "./phone-sheet-swipe";
import type { AdaptivePanelPlacement } from "./adaptive-panel-placement";

interface PanelInteractionOptions {
  readonly owner: Component;
  readonly ownerDocument: Document;
  readonly layer: HTMLElement;
  readonly surface: HTMLElement;
  readonly scroll: HTMLElement;
  readonly anchor: HTMLElement;
  readonly initialFocus?: HTMLElement;
  readonly externalFocusTarget?: ExternalPanelFocusTarget;
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
  owner.register(
    registerFocusNavigation(
      options.layer,
      !Platform.isPhone &&
        options.anchor.closest('[data-inkbook-keyboard-navigation="true"]') !== null,
    ),
  );
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || !options.topmost()) return;
    if (event.key === "Escape") {
      if (
        ownedPanelPopups(surface).some(
          ({ anchor, popup }) => event.target === anchor || popup.contains(event.target as Node),
        )
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      options.backOrClose();
      return;
    }
    if (
      event.key === "Tab" &&
      !isExternalPanelFocus(surface, event.target, options.externalFocusTarget)
    )
      cycleModalFocus(event, options.focusable());
  };
  const onOutsidePointer = (event: PointerEvent): void => {
    if (!options.topmost()) return;
    const target = event.target;
    if (target === null || !("nodeType" in target)) return;
    if (
      containsOwnedMenuTarget(surface, target as Node) ||
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
    owner.register(
      trapPhoneSheetFocus(
        surface,
        options.initialFocus ?? surface,
        options.topmost,
        options.externalFocusTarget,
      ),
    );
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

/** Keyboard entry and cycling use the same currently available panel controls. */
export function panelFocusableElements(surface: HTMLElement): HTMLElement[] {
  const popups = ownedPanelPopups(surface);
  return focusableElements(surface).flatMap((element) => [
    element,
    ...popups
      .filter(({ anchor }) => anchor === element)
      .flatMap(({ popup }) => focusableElements(popup)),
  ]);
}

function ownedPanelPopups(surface: HTMLElement): { anchor: HTMLElement; popup: HTMLElement }[] {
  const result: { anchor: HTMLElement; popup: HTMLElement }[] = [];
  for (const id of surface.getAttribute("aria-owns")?.split(/\s+/).filter(Boolean) ?? []) {
    const popup = surface.ownerDocument.getElementById(id);
    const anchorId = popup?.dataset.inkbookMenuAnchor;
    const anchor = anchorId === undefined ? null : surface.ownerDocument.getElementById(anchorId);
    if (
      popup !== null &&
      anchor !== null &&
      surface.contains(anchor) &&
      !surface.contains(popup) &&
      popup.closest("[hidden], [inert]") === null &&
      containsOwnedMenuTarget(surface, popup)
    )
      result.push({ anchor, popup });
  }
  return result;
}

function focusableElements(surface: HTMLElement): HTMLElement[] {
  const selector =
    "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
  return [...surface.querySelectorAll<HTMLElement>(selector)].filter(
    (element) =>
      !element.hasAttribute("disabled") &&
      element.tabIndex !== -1 &&
      element.closest("[hidden], [inert]") === null,
  );
}

interface PanelViewportOptions {
  readonly owner: Component;
  readonly ownerWindow: Window;
  readonly ownerDocument: Document;
  readonly surface: HTMLElement;
  readonly placement: AdaptivePanelPlacement;
  readonly contentScroll?: HTMLElement | undefined;
  readonly reposition: (revealEditable?: boolean) => void;
}

/** Owning-window and visual viewport listeners keep phone sheets above the keyboard. */
export function registerPanelViewport(options: PanelViewportOptions): void {
  const { owner, ownerWindow, ownerDocument, surface, placement } = options;
  const reveal = (): void => options.reposition(true);
  if (Platform.isPhone && options.contentScroll !== undefined)
    owner.registerDomEvent(options.contentScroll, "focusin", reveal);
  owner.register(placement.observeKeyboard(reveal));
  const onScroll = (event: Event): void => {
    const target = event.target;
    if (target !== null && "nodeType" in target && containsOwnedMenuTarget(surface, target as Node))
      return;
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
