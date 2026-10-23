import { effectiveTransitionDuration } from "../../runtime/effective-motion";
import { playMenuMotion } from "./menu-motion";

interface CheckMotion {
  update(): void;
  finish(): void;
  dispose(): void;
}

/** Keeps checkmark paint independent of immediate background-choice semantics. */
export function registerBackgroundChoiceMotion(
  root: HTMLElement,
  anchor: HTMLElement,
  ownerWindow: Window,
): Pick<CheckMotion, "finish" | "dispose"> {
  const checks = new Map<HTMLButtonElement, CheckMotion>();
  const refresh = (): void => {
    const buttons = new Set(
      [...root.querySelectorAll<HTMLButtonElement>(".inkbook-menu-background-choice")].filter(
        (button) => {
          const owner = button.closest("[data-inkbook-feedback-owner]");
          return owner === null || owner === root || !root.contains(owner);
        },
      ),
    );
    for (const [button, motion] of checks) {
      if (buttons.has(button)) continue;
      motion.dispose();
      checks.delete(button);
    }
    for (const button of buttons) {
      const motion = checks.get(button);
      if (motion !== undefined) motion.update();
      else {
        const created = createCheckMotion(button, anchor, ownerWindow);
        if (created !== undefined) checks.set(button, created);
      }
    }
  };
  const observerConstructor = (
    ownerWindow as Window & { MutationObserver: typeof MutationObserver }
  ).MutationObserver;
  const observer = new observerConstructor(refresh);
  refresh();
  observer.observe(root, {
    attributes: true,
    attributeFilter: ["aria-pressed"],
    childList: true,
    subtree: true,
  });
  return {
    finish: () => {
      refresh();
      for (const motion of checks.values()) motion.finish();
    },
    dispose: () => {
      observer.disconnect();
      for (const motion of checks.values()) motion.dispose();
      checks.clear();
    },
  };
}

function createCheckMotion(
  button: HTMLButtonElement,
  anchor: HTMLElement,
  ownerWindow: Window,
): CheckMotion | undefined {
  const check = button.querySelector<HTMLElement>(".inkbook-menu-background-choice-check");
  if (check === null) return undefined;
  const originalOpacity = check.style.getPropertyValue("opacity");
  const originalPriority = check.style.getPropertyPriority("opacity");
  let selected = button.getAttribute("aria-pressed") === "true";
  let stop: (() => void) | undefined;
  const finish = (): void => {
    stop?.();
    stop = undefined;
    selected = button.getAttribute("aria-pressed") === "true";
    check.hidden = !selected;
    check.style.opacity = selected ? "1" : "0";
  };
  check.dataset.inkbookMotionCheck = "true";
  finish();
  return {
    update: () => {
      const next = button.getAttribute("aria-pressed") === "true";
      if (next === selected) return;
      const current = ownerWindow.getComputedStyle(check).opacity || (selected ? "1" : "0");
      stop?.();
      selected = next;
      check.hidden = false;
      check.style.opacity = current;
      stop = playMenuMotion(
        check,
        { opacity: [current, selected ? "1" : "0"] },
        effectiveTransitionDuration(anchor, ownerWindow, "toolActiveState"),
        () => {
          check.hidden = !selected;
        },
      );
    },
    finish,
    dispose: () => {
      finish();
      delete check.dataset.inkbookMotionCheck;
      if (originalOpacity) check.style.setProperty("opacity", originalOpacity, originalPriority);
      else check.style.removeProperty("opacity");
    },
  };
}
