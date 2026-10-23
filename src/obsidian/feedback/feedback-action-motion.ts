import {
  registerKeyboardPress,
  registerOwnedMotionPress,
} from "../../rendering/motion/keyboard-press";
import { observeEffectiveMotion } from "../runtime/effective-motion";
import { hover } from "motion";

import { STANDARD_EASING } from "../../rendering/motion/transitions";
import { animateOwnedElement } from "../runtime/element-motion";
import { effectiveTransitionDuration } from "../runtime/effective-motion";

/** Owns pointer and keyboard feedback for one native action button. */
export function mountFeedbackActionMotion(
  button: HTMLButtonElement,
  ownerWindow: Window,
): { dispose: () => void; refresh: () => void } {
  const normalColor =
    button.dataset.inkbookFeedbackTone === "danger" ? "var(--text-error)" : "var(--text-muted)";
  let hovering = false;
  let pressing = false;
  let focused = false;
  let animation: ReturnType<typeof animateOwnedElement> | undefined;
  const render = (): void => {
    const active = !button.disabled;
    const background =
      active && pressing
        ? "var(--interactive-hover)"
        : active && (hovering || focused)
          ? "var(--background-modifier-hover)"
          : "transparent";
    const color =
      active && (hovering || focused) && button.dataset.inkbookFeedbackTone !== "danger"
        ? "var(--text-normal)"
        : normalColor;
    const duration = button.disabled
      ? 0
      : effectiveTransitionDuration(button, ownerWindow, "toolActiveState");
    const canAnimate = duration > 0 && typeof button.animate === "function";
    const current = canAnimate ? ownerWindow.getComputedStyle(button) : undefined;
    const currentBackground = current?.backgroundColor ?? "transparent";
    const currentColor = current?.color ?? normalColor;
    animation?.cancel();
    if (!canAnimate) {
      button.style.setProperty("background-color", background);
      button.style.setProperty("color", color);
      return;
    }
    animation = animateOwnedElement(
      button,
      {
        backgroundColor: [currentBackground, background],
        color: [currentColor, color],
      },
      { duration: duration / 1000, ease: STANDARD_EASING },
    );
    for (const native of button.getAnimations()) void native.finished.catch(() => undefined);
    void animation.finished.catch(() => undefined);
  };
  const setHover = (value: boolean): void => {
    hovering = value && !button.disabled;
    render();
  };
  const setPress = (value: boolean): void => {
    pressing = value && !button.disabled;
    render();
  };
  const stopGestures =
    typeof window !== "undefined" && ownerWindow === window
      ? mountMotionGestures(button, setHover, setPress)
      : mountPopoutGestures(button, ownerWindow, setHover, setPress);
  const onFocus = (): void => {
    focused = button.matches(":focus-visible");
    render();
  };
  const onBlur = (): void => {
    focused = false;
    pressing = false;
    render();
  };
  const releasePreference = observeEffectiveMotion(button, undefined, (reduced) => {
    if (reduced) render();
  });
  button.addEventListener("focus", onFocus);
  button.addEventListener("blur", onBlur);
  return {
    refresh: () => {
      if (button.disabled) {
        hovering = false;
        pressing = false;
        focused = false;
      }
      render();
    },
    dispose: () => {
      releasePreference();
      stopGestures();
      button.removeEventListener("focus", onFocus);
      button.removeEventListener("blur", onBlur);
      animation?.cancel();
      button.style.removeProperty("background-color");
      button.style.removeProperty("color");
    },
  };
}

function mountMotionGestures(
  button: HTMLButtonElement,
  setHover: (value: boolean) => void,
  setPress: (value: boolean) => void,
): () => void {
  const stopHover = hover([button], () => {
    if (button.disabled) return;
    setHover(true);
    return () => setHover(false);
  });
  const stopPress = registerOwnedMotionPress([button], () => {
    if (button.disabled) return;
    setPress(true);
    return () => setPress(false);
  });
  const stopKeyboard = registerKeyboardPress(button, () => {
    if (button.disabled) return undefined;
    setPress(true);
    return () => setPress(false);
  });
  return () => {
    stopKeyboard();
    stopHover();
    stopPress();
  };
}

/** Motion 14.6 binds gesture release to the global window, so pop-outs own their events. */
function mountPopoutGestures(
  button: HTMLButtonElement,
  ownerWindow: Window,
  setHover: (value: boolean) => void,
  setPress: (value: boolean) => void,
): () => void {
  const onEnter = (event: PointerEvent): void => {
    if (event.pointerType !== "touch") setHover(true);
  };
  const onLeave = (event: PointerEvent): void => {
    if (event.pointerType !== "touch") setHover(false);
  };
  const onDown = (event: PointerEvent): void => {
    if (event.isPrimary && event.button === 0) setPress(true);
  };
  const onRelease = (): void => setPress(false);
  const stopKeyboard = registerKeyboardPress(
    button,
    () => {
      if (button.disabled) return undefined;
      setPress(true);
      return onRelease;
    },
    true,
  );
  const onWindowBlur = (): void => {
    setHover(false);
    onRelease();
  };
  button.addEventListener("pointerenter", onEnter);
  button.addEventListener("pointerleave", onLeave);
  button.addEventListener("pointerdown", onDown);
  ownerWindow.addEventListener("blur", onWindowBlur);
  ownerWindow.addEventListener("pagehide", onWindowBlur);
  ownerWindow.addEventListener("pointerup", onRelease, true);
  ownerWindow.addEventListener("pointercancel", onRelease, true);
  return () => {
    button.removeEventListener("pointerenter", onEnter);
    button.removeEventListener("pointerleave", onLeave);
    button.removeEventListener("pointerdown", onDown);
    stopKeyboard();
    ownerWindow.removeEventListener("blur", onWindowBlur);
    ownerWindow.removeEventListener("pagehide", onWindowBlur);
    ownerWindow.removeEventListener("pointerup", onRelease, true);
    ownerWindow.removeEventListener("pointercancel", onRelease, true);
  };
}
