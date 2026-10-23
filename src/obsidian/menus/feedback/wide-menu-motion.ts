import { playMenuMotion } from "./menu-motion";

/** Start an exit from the currently rendered frame, including an interrupted entrance. */
export function animateWideMenuExit(
  surface: HTMLElement,
  ownerWindow: Window,
  durationMs: number,
  onComplete: () => void,
): () => void {
  const style = ownerWindow.getComputedStyle(surface);
  return playMenuMotion(
    surface,
    {
      opacity: [style.opacity || "1", "0"],
      scale: [!style.scale || style.scale === "none" ? "1" : style.scale, "0.96"],
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
