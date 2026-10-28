import { effectiveTransitionDuration } from "../../runtime/effective-motion";
import { playMenuMotion } from "./menu-motion";

export function registerMenuSwitchFeedback(
  root: HTMLElement,
  anchor: HTMLElement,
  ownerWindow: Window,
): { finish: () => void; refresh: () => void; dispose: () => void } {
  const releases: (() => void)[] = [];
  const finishes: (() => void)[] = [];
  const refreshes: (() => void)[] = [];
  for (const input of root.querySelectorAll<HTMLInputElement>(".inkbook-menu-switch input")) {
    if (input.closest("[data-inkbook-feedback-owner]") !== root) continue;
    const track = input.nextElementSibling as HTMLElement | null;
    const thumb = track?.firstElementChild as HTMLElement | null;
    if (track === null || thumb === null) continue;
    let stopTrack: (() => void) | undefined;
    let stopThumb: (() => void) | undefined;
    const restore = (): void => {
      track.style.removeProperty("background-color");
      thumb.style.removeProperty("translate");
    };
    const syncState = (): void => {
      track.dataset.inkbookSwitchState = input.checked ? "checked" : "unchecked";
    };
    const finish = (): void => {
      stopTrack?.();
      stopThumb?.();
      syncState();
      restore();
    };
    const onChange = (): void => {
      const duration = effectiveTransitionDuration(anchor, ownerWindow, "toolActiveState");
      const trackColor = ownerWindow.getComputedStyle(track).backgroundColor;
      const thumbPosition = ownerWindow.getComputedStyle(thumb).translate;
      stopTrack?.();
      stopThumb?.();
      syncState();
      restore();
      const targetColor = ownerWindow.getComputedStyle(track).backgroundColor;
      const targetPosition = ownerWindow.getComputedStyle(thumb).translate;
      track.style.backgroundColor = trackColor;
      thumb.style.translate = thumbPosition;
      stopTrack = playMenuMotion(
        track,
        {
          backgroundColor: [trackColor, targetColor],
        },
        duration,
        () => track.style.removeProperty("background-color"),
      );
      stopThumb = playMenuMotion(
        thumb,
        { translate: [thumbPosition || "0 0", targetPosition || "0 0"] },
        duration,
        () => thumb.style.removeProperty("translate"),
      );
    };
    // Retain the visual state separately from immediate native checkbox semantics.
    finish();
    input.addEventListener("change", onChange);
    finishes.push(finish);
    refreshes.push(onChange);
    releases.push(() => {
      input.removeEventListener("change", onChange);
      stopTrack?.();
      stopThumb?.();
      restore();
      delete track.dataset.inkbookSwitchState;
    });
  }
  return {
    finish: () => finishes.forEach((finish) => finish()),
    refresh: () => refreshes.forEach((refresh) => refresh()),
    dispose: () => releases.forEach((release) => release()),
  };
}
