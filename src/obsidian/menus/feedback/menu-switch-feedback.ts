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
    const finish = (): void => {
      stopTrack?.();
      stopThumb?.();
      track.style.setProperty(
        "background-color",
        input.checked ? "var(--interactive-accent)" : "var(--background-modifier-border-hover)",
      );
      thumb.style.setProperty("translate", input.checked ? "18px 0" : "0 0");
    };
    const onChange = (): void => {
      const duration = effectiveTransitionDuration(anchor, ownerWindow, "toolActiveState");
      const trackColor = ownerWindow.getComputedStyle(track).backgroundColor;
      const thumbPosition = ownerWindow.getComputedStyle(thumb).translate;
      stopTrack?.();
      stopThumb?.();
      track.style.backgroundColor = trackColor;
      thumb.style.translate = thumbPosition;
      stopTrack = playMenuMotion(
        track,
        {
          backgroundColor: [
            trackColor,
            input.checked ? "var(--interactive-accent)" : "var(--background-modifier-border-hover)",
          ],
        },
        duration,
      );
      stopThumb = playMenuMotion(
        thumb,
        { translate: [thumbPosition, input.checked ? "18px 0" : "0 0"] },
        duration,
      );
    };
    // Own the initial paint before the browser changes :checked on the first activation.
    finish();
    input.addEventListener("change", onChange);
    finishes.push(finish);
    refreshes.push(onChange);
    releases.push(() => {
      input.removeEventListener("change", onChange);
      stopTrack?.();
      stopThumb?.();
    });
  }
  return {
    finish: () => finishes.forEach((finish) => finish()),
    refresh: () => refreshes.forEach((refresh) => refresh()),
    dispose: () => releases.forEach((release) => release()),
  };
}
