import { playMenuMotion } from "./menu-motion";

/** Start an exit from the currently rendered frame, including an interrupted entrance. */
export function animateWideMenuExit(
  surface: HTMLElement,
  ownerWindow: Window,
  durationMs: number,
  onComplete: () => void,
  stopEntry?: () => void,
): () => void {
  const { opacity, scale } = ownerWindow.getComputedStyle(surface);
  stopEntry?.();
  return playMenuMotion(
    surface,
    {
      opacity: [opacity || "1", "0"],
      scale: [!scale || scale === "none" ? "1" : scale, "0.96"],
    },
    durationMs,
    onComplete,
    "ease-out",
  );
}

export function animateWideMenuEntry(
  surface: HTMLElement,
  durationMs: number,
  onComplete?: () => void,
): () => void {
  return playMenuMotion(
    surface,
    { opacity: ["0", "1"], scale: ["0.96", "1"] },
    durationMs,
    onComplete,
    "ease-out",
  );
}
