import { animateOwnedElements, type ElementMotionTarget } from "../../runtime/element-motion";

import { EASING_TOKENS } from "../../../rendering/motion/transitions";
import { effectiveTransitionDuration } from "../../runtime/effective-motion";

type Keyframes = ElementMotionTarget["keyframes"];

/** A cancellable, lifecycle-owned animation with a completion that cannot fire after cancellation. */
export function playMenuMotion(
  element: HTMLElement,
  keyframes: Keyframes,
  durationMs: number,
  onComplete?: () => void,
  easing: string = EASING_TOKENS.standard,
): () => void {
  return playMenuMotionGroup([{ element, keyframes }], durationMs, onComplete, easing);
}

/** Keeps a shared exit alive until its surface and backdrop have both completed. */
export function playMenuMotionGroup(
  targets: readonly ElementMotionTarget[],
  durationMs: number,
  onComplete?: () => void,
  easing: string = EASING_TOKENS.standard,
): () => void {
  if (durationMs === 0) {
    for (const { element, keyframes } of targets)
      for (const [name, values] of Object.entries(keyframes)) {
        const value: unknown = Array.isArray(values) ? values[values.length - 1] : values;
        if (typeof value === "string" || typeof value === "number")
          element.style.setProperty(toCssProperty(name), String(value));
      }
    onComplete?.();
    return () => undefined;
  }
  let canceled = false;
  const animation = animateOwnedElements(targets, {
    duration: durationMs / 1000,
    ease: easing as NonNullable<Parameters<typeof animateOwnedElements>[1]["ease"]>,
    onComplete: () => {
      if (!canceled) onComplete?.();
    },
  });
  // Native WAAPI rejects `finished` when an interrupted animation is canceled.
  void animation.finished.catch(() => undefined);
  return () => {
    canceled = true;
    animation.cancel();
  };
}

function toCssProperty(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** Observe only the owning preference node and the owning window's system preference. */
export function observeMenuMotionPreference(
  anchor: HTMLElement,
  ownerWindow: Window,
  onReduced: () => void,
): () => void {
  const query = ownerWindow.matchMedia?.("(prefers-reduced-motion: reduce)");
  const check = (): void => {
    if (effectiveTransitionDuration(anchor, ownerWindow, "adaptiveMenu") === 0) onReduced();
  };
  query?.addEventListener("change", check);
  const root = anchor.closest("[data-inkbook-motion]");
  const observerConstructor = (
    ownerWindow as Window & { MutationObserver?: typeof MutationObserver }
  ).MutationObserver;
  const observer =
    root !== null && observerConstructor !== undefined ? new observerConstructor(check) : undefined;
  if (root !== null)
    observer?.observe(root, { attributes: true, attributeFilter: ["data-inkbook-motion"] });
  return () => {
    query?.removeEventListener("change", check);
    observer?.disconnect();
  };
}
