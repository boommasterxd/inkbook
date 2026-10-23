import {
  registerKeyboardPress,
  registerOwnedMotionPress,
} from "../../../rendering/motion/keyboard-press";
import { hover } from "motion";

import { observeMenuMotionPreference } from "./menu-motion";
import { createMenuColorAnimator, type ChangeMenuColor } from "./menu-choice-motion";
import { registerMenuSwitchFeedback } from "./menu-switch-feedback";
import { registerBackgroundChoiceMotion } from "./background-choice-motion";

interface MenuChoiceController {
  readonly items: readonly HTMLElement[];
  readonly itemAt: (target: EventTarget | null) => HTMLElement | undefined;
  readonly change: ChangeMenuColor;
  readonly moveHover: (event: PointerEvent) => void;
  readonly finishHover: () => void;
  readonly onFocusIn: (event: FocusEvent) => void;
  readonly onFocusOut: (event: FocusEvent) => void;
  readonly onKeyDown: (event: KeyboardEvent) => void;
  readonly onPointerDown: () => void;
  readonly onDisabled: (item: HTMLElement) => void;
  readonly finish: () => void;
  readonly dispose: () => void;
}

export interface MenuFeedbackRegistration {
  (): void;
  /** Refresh visual state after an owner updates native controls without user input. */
  refresh(): void;
}

function createMenuChoiceController(
  root: HTMLElement,
  anchor: HTMLElement,
  ownerWindow: Window,
): MenuChoiceController {
  const selector =
    ".inkbook-adaptive-panel-back, .inkbook-owned-menu-item[tabindex], .inkbook-menu-choice, .inkbook-menu-stepper-button, .inkbook-menu-background-choice, .inkbook-dialog-actions button, .inkbook-shortcut-icon-button, .inkbook-shortcut-recorder, .inkbook-shortcuts-group-reset";
  const itemAt = menuItemLookup(root, selector);
  let hovered: HTMLElement | undefined;
  let pressed: HTMLElement | undefined;
  let keyboardFocus: HTMLElement | undefined;
  let keyboardNavigation = false;
  const items = [root, ...root.querySelectorAll<HTMLElement>(selector)].filter(
    (item) => item.matches(selector) && itemAt(item) === item,
  );
  const motion = createMenuColorAnimator(
    root,
    anchor,
    ownerWindow,
    (item) => item === hovered || item === keyboardFocus || item === pressed,
    items,
  );
  const update: ChangeMenuColor = (item, color) =>
    motion.change(
      item,
      item !== undefined && item === pressed ? "var(--interactive-hover)" : color,
    );
  const change: ChangeMenuColor = (item, color) => {
    pressed = color === "var(--interactive-hover)" ? item : undefined;
    update(item, color);
  };
  const moveHover = (event: PointerEvent): void => {
    if (event.pointerType === "touch") return;
    const next = itemAt(event.target);
    if (next === hovered) return;
    const previous = hovered;
    hovered = next;
    update(previous);
    update(next, "var(--background-modifier-hover)");
  };
  const finishHover = (): void => {
    root.removeEventListener("pointerover", moveHover);
    const previous = hovered;
    hovered = undefined;
    update(previous);
  };
  const onFocusIn = (event: FocusEvent): void => {
    const item = itemAt(event.target);
    if (item === undefined) return;
    keyboardFocus =
      keyboardNavigation || root.closest('[data-inkbook-keyboard-navigation="true"]') !== null
        ? item
        : undefined;
    if (keyboardFocus !== undefined) update(item, "var(--background-modifier-hover)");
  };
  const onFocusOut = (event: FocusEvent): void => {
    const item = itemAt(event.target);
    if (keyboardFocus === item) keyboardFocus = undefined;
    if (pressed === item) pressed = undefined;
    update(item);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (
      event.key === "Tab" ||
      event.key.startsWith("Arrow") ||
      event.key === "Home" ||
      event.key === "End"
    )
      keyboardNavigation = true;
  };
  const onPointerDown = (): void => {
    keyboardNavigation = false;
    const previous = keyboardFocus;
    keyboardFocus = undefined;
    update(previous);
  };
  return {
    items,
    itemAt,
    change,
    moveHover,
    finishHover,
    onFocusIn,
    onFocusOut,
    onKeyDown,
    onPointerDown,
    onDisabled: (item) => {
      if (!item.matches(":disabled, [aria-disabled='true']")) return;
      if (hovered === item) hovered = undefined;
      if (pressed === item) pressed = undefined;
      if (keyboardFocus === item) keyboardFocus = undefined;
      update(item);
    },
    finish: motion.finish,
    dispose: motion.dispose,
  };
}

function registerMenuChoiceFeedback(
  root: HTMLElement,
  ownerWindow: Window,
  state: MenuChoiceController,
): () => void {
  const observerConstructor = (
    ownerWindow as Window & { MutationObserver: typeof MutationObserver }
  ).MutationObserver;
  const observer = new observerConstructor((records) => {
    for (const record of records) state.onDisabled(record.target as HTMLElement);
  });
  observer.observe(root, {
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled", "aria-disabled"],
  });
  root.ownerDocument.addEventListener("keydown", state.onKeyDown, true);
  root.addEventListener("pointerdown", state.onPointerDown);
  root.addEventListener("focusin", state.onFocusIn);
  root.addEventListener("focusout", state.onFocusOut);
  const popout = ownerWindow !== window;
  const leaveHover = popout
    ? registerOwnedWindowHover(root, state.moveHover, state.finishHover)
    : hover([root], (_, event) => {
        state.moveHover(event);
        root.addEventListener("pointerover", state.moveHover);
        return state.finishHover;
      });
  const leavePress = popout
    ? registerOwnedWindowPress(root, ownerWindow, state.itemAt, state.change)
    : registerOwnedMotionPress(state.items, (_, event) => {
        const item = state.itemAt(event.target);
        state.change(item, "var(--interactive-hover)");
        return () => state.change(item);
      });
  const leaveKeyboard = registerKeyboardPress(
    root,
    (event) => {
      const current = state.itemAt(event.target);
      if (current === undefined) return undefined;
      state.change(current, "var(--interactive-hover)");
      return () => state.change(current);
    },
    popout,
  );
  return () => {
    observer.disconnect();
    leaveKeyboard();
    leaveHover();
    leavePress();
    root.removeEventListener("pointerover", state.moveHover);
    root.ownerDocument.removeEventListener("keydown", state.onKeyDown, true);
    root.removeEventListener("pointerdown", state.onPointerDown);
    root.removeEventListener("focusin", state.onFocusIn);
    root.removeEventListener("focusout", state.onFocusOut);
    state.dispose();
  };
}

/** Menu-owned Motion gestures and theme-aware state changes. */
export function registerMenuFeedback(
  root: HTMLElement,
  anchor: HTMLElement,
  ownerWindow: Window,
): MenuFeedbackRegistration {
  root.dataset.inkbookFeedbackOwner = "true";
  const choices = createMenuChoiceController(root, anchor, ownerWindow);
  const releaseChoices = registerMenuChoiceFeedback(root, ownerWindow, choices);
  const switches = registerMenuSwitchFeedback(root, anchor, ownerWindow);
  const backgrounds = registerBackgroundChoiceMotion(root, anchor, ownerWindow);
  const releasePreference = observeMenuMotionPreference(anchor, ownerWindow, () => {
    choices.finish();
    switches.finish();
    backgrounds.finish();
  });
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    releasePreference();
    releaseChoices();
    switches.dispose();
    backgrounds.dispose();
    delete root.dataset.inkbookFeedbackOwner;
  };
  return Object.assign(dispose, {
    refresh: () => {
      if (!disposed) switches.refresh();
    },
  });
}

/** Motion gestures bind release to the main window; pop-outs need their owning window. */
function registerOwnedWindowHover(
  root: HTMLElement,
  move: (event: PointerEvent) => void,
  finish: () => void,
): () => void {
  const onOver = (event: PointerEvent): void => {
    if (event.pointerType !== "touch") move(event);
  };
  const onLeave = (event: PointerEvent): void => {
    if (event.pointerType !== "touch") finish();
  };
  root.addEventListener("pointerover", onOver);
  root.addEventListener("pointerleave", onLeave);
  return () => {
    root.removeEventListener("pointerover", onOver);
    root.removeEventListener("pointerleave", onLeave);
  };
}

function registerOwnedWindowPress(
  root: HTMLElement,
  ownerWindow: Window,
  itemAt: (target: EventTarget | null) => HTMLElement | undefined,
  change: (item: HTMLElement | undefined, color?: string) => void,
): () => void {
  let pointerId: number | undefined;
  let pressed: HTMLElement | undefined;
  const release = (event: PointerEvent): void => {
    if (pointerId !== event.pointerId) return;
    pointerId = undefined;
    ownerWindow.removeEventListener("pointerup", release, true);
    ownerWindow.removeEventListener("pointercancel", release, true);
    change(pressed);
    pressed = undefined;
  };
  const down = (event: PointerEvent): void => {
    if (pointerId !== undefined || !event.isPrimary || event.button !== 0) return;
    pressed = itemAt(event.target);
    if (pressed === undefined) return;
    pointerId = event.pointerId;
    change(pressed, "var(--interactive-hover)");
    ownerWindow.addEventListener("pointerup", release, true);
    ownerWindow.addEventListener("pointercancel", release, true);
  };
  root.addEventListener("pointerdown", down);
  return () => {
    root.removeEventListener("pointerdown", down);
    ownerWindow.removeEventListener("pointerup", release, true);
    ownerWindow.removeEventListener("pointercancel", release, true);
    change(pressed);
  };
}

function menuItemLookup(root: HTMLElement, selector: string): MenuChoiceController["itemAt"] {
  return (target: EventTarget | null): HTMLElement | undefined => {
    if (target === null || !("closest" in target)) return undefined;
    const item = (target as Element).closest<HTMLElement>(selector);
    return item !== null &&
      root.contains(item) &&
      item.closest("[data-inkbook-feedback-owner]") === root &&
      !item.matches(":disabled, [aria-disabled='true']")
      ? item
      : undefined;
  };
}
