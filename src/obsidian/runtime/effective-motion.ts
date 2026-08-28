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
    if (current.classList.contains("inkbook-root")) return current;
    current = current.parentElement;
  }
  return undefined;
}

function motionPreference(value: string | undefined): MotionPreference {
  if (value === "full" || value === "reduced") return value;
  return "system";
}
