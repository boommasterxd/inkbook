import { playMenuMotion } from "../feedback/menu-motion";

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
  const stopSurface = playMenuMotion(
    surface,
    { translate: [position === "none" ? "0 0" : position, "0 100%"] },
    durationMs,
    onComplete,
    "ease-in",
  );
  const stopBackdrop = playMenuMotion(
    backdrop,
    { opacity: [opacity || "1", "0"] },
    durationMs,
    undefined,
    "ease-in",
  );
  return () => {
    stopSurface();
    stopBackdrop();
  };
}
