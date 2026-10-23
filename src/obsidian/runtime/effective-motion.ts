import {
  getTransitionDuration,
  isReducedMotion,
  type MotionPreference,
  type TransitionName,
} from "../../rendering/motion/transitions";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export function effectiveTransitionDuration(
  element: HTMLElement,
  ownerWindow: Window,
  transition: TransitionName,
): number {
  const preference = motionPreference(inkbookRoot(element)?.dataset.inkbookMotion);
  const systemReduced = ownerWindow.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false;
  return getTransitionDuration(transition, isReducedMotion(preference, systemReduced));
}

function inkbookRoot(element: HTMLElement): HTMLElement | undefined {
  let current: HTMLElement | null = element;
  while (current !== null) {
    if (current.hasAttribute("data-inkbook-motion")) return current;
    current = current.parentElement;
  }
  return undefined;
}

function motionPreference(value: string | undefined): MotionPreference {
  if (value === "full" || value === "reduced") return value;
  return "system";
}

export type ObserveMotion = (listener: () => void) => () => void;

/** Own preference subscriptions for native and React boundary adapters. */
export function observeEffectiveMotion(
  element: HTMLElement,
  readMotion: (() => MotionPreference) | undefined,
  onChange: (reduced: boolean) => void,
  observeMotion?: ObserveMotion,
): () => void {
  const ownerWindow = element.ownerDocument.defaultView;
  const query = ownerWindow?.matchMedia?.(REDUCED_MOTION_QUERY);
  let previous: boolean | undefined;
  let previousPreference: MotionPreference | undefined;
  const check = (): void => {
    const preference =
      readMotion?.() ?? motionPreference(inkbookRoot(element)?.dataset.inkbookMotion);
    const reduced = isReducedMotion(preference, query?.matches ?? false);
    if (reduced === previous && preference === previousPreference) return;
    previousPreference = preference;
    previous = reduced;
    onChange(reduced);
  };
  const root = inkbookRoot(element);
  const observerConstructor = (
    ownerWindow as (Window & { MutationObserver?: typeof MutationObserver }) | null
  )?.MutationObserver;
  const observer =
    root === undefined || observerConstructor === undefined
      ? undefined
      : new observerConstructor(check);
  if (root !== undefined)
    observer?.observe(root, { attributes: true, attributeFilter: ["data-inkbook-motion"] });
  query?.addEventListener?.("change", check);
  const unsubscribe = observeMotion?.(check);
  check();
  return () => {
    unsubscribe?.();
    query?.removeEventListener?.("change", check);
    observer?.disconnect();
  };
}
