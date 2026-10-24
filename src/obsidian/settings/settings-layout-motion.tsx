import type { MotionPreference } from "../../rendering/motion/transitions";
import type { ObserveMotion } from "../runtime/effective-motion";
import { createSettingsValidationMotion } from "./settings-validation-motion";

export function createSettingsLayoutMotion(
  content: HTMLElement,
  readMotion: () => MotionPreference,
  observeMotion?: ObserveMotion,
): {
  mutate: (update: () => void) => void;
  dispose: () => void;
} {
  const motion = createSettingsValidationMotion(content, {
    readMotion,
    ...(observeMotion === undefined ? {} : { observeMotion }),
  });
  return { mutate: motion.mutate, dispose: motion.dispose };
}
