import { playMenuMotionGroup } from "../feedback/menu-motion";

/** Mount the shared phone backdrop and sheet in the same entrance group. */
export function animatePhoneSheetEntry(
  surface: HTMLElement,
  backdrop: HTMLElement,
  durationMs: number,
  onComplete: () => void,
): () => void {
  return playMenuMotionGroup(
    [
      { element: surface, keyframes: { translate: ["0 100%", "0 0"] } },
      { element: backdrop, keyframes: { opacity: [0, 1] } },
    ],
    durationMs,
    onComplete,
    "ease-out",
  );
}

/** Exit from the rendered swipe or entrance position. */
export function animatePhoneSheetExit(
  surface: HTMLElement,
  backdrop: HTMLElement,
  ownerWindow: Window,
  durationMs: number,
  onComplete: () => void,
): () => void {
  const position = ownerWindow.getComputedStyle(surface).translate;
  const opacity = ownerWindow.getComputedStyle(backdrop).opacity;
  return playMenuMotionGroup(
    [
      {
        element: surface,
        keyframes: { translate: [position === "none" ? "0 0" : position, "0 100%"] },
      },
      { element: backdrop, keyframes: { opacity: [opacity || "1", "0"] } },
    ],
    durationMs,
    onComplete,
    "ease-in",
  );
}
