import type { MotionPreference } from "../../../rendering/motion/transitions";
import { registerMenuFeedback, type MenuFeedbackRegistration } from "./menu-feedback";

export interface NativeControlFeedbackOptions {
  readonly readMotion: () => MotionPreference;
  readonly observeMotion?: (listener: () => void) => () => void;
}

/** Explicitly owns a settings subtree, including lazily mounted replacement controls. */
export function registerNativeControlFeedback(
  root: HTMLElement,
  options: NativeControlFeedbackOptions,
): MenuFeedbackRegistration {
  const ownerWindow = root.ownerDocument.defaultView;
  if (ownerWindow === null) return Object.assign(() => undefined, { refresh: () => undefined });
  const updatePreference = (): void => {
    const preference = options.readMotion();
    if (root.dataset.inkbookMotion !== preference) root.dataset.inkbookMotion = preference;
  };
  updatePreference();
  const release = registerMenuFeedback(root, root, ownerWindow);
  const unsubscribe = options.observeMotion?.(updatePreference);
  root.addEventListener("pointerdown", updatePreference, true);
  root.addEventListener("pointerover", updatePreference, true);
  root.addEventListener("keydown", updatePreference, true);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    unsubscribe?.();
    root.removeEventListener("pointerdown", updatePreference, true);
    root.removeEventListener("pointerover", updatePreference, true);
    root.removeEventListener("keydown", updatePreference, true);
    release();
    delete root.dataset.inkbookMotion;
  };
  return Object.assign(dispose, {
    refresh: () => {
      if (disposed) return;
      updatePreference();
      release.refresh();
    },
  });
}
