import { GroupAnimationWithThen, NativeAnimation } from "motion";
import type { NativeAnimationOptions } from "motion";

type Keyframe = string | number;
type ElementKeyframes = Readonly<Record<string, Keyframe | readonly Keyframe[]>>;
type ElementMotionOptions = Pick<
  NativeAnimationOptions,
  "ease" | "repeat" | "repeatType" | "onComplete"
> & { readonly duration: number };

export interface ElementMotionTarget {
  readonly element: HTMLElement;
  readonly keyframes: ElementKeyframes;
}

/** Full Motion's native API keeps explicit visual targets in their owning DOM realm. */
export function animateOwnedElement(
  element: HTMLElement,
  keyframes: ElementKeyframes,
  options: ElementMotionOptions,
): GroupAnimationWithThen {
  return animateOwnedElements([{ element, keyframes }], options);
}

/** Completes coordinated surfaces only after every owned property has finished. */
export function animateOwnedElements(
  targets: readonly ElementMotionTarget[],
  options: ElementMotionOptions,
): GroupAnimationWithThen {
  const entries = targets.flatMap(({ element, keyframes }) =>
    Object.entries(keyframes).map(([name, values]) => ({ element, name, values })),
  );
  let remaining = entries.length;
  const animations = entries.map(
    ({ element, name, values }) =>
      new NativeAnimation({
        ...options,
        element,
        name,
        keyframes:
          typeof values === "string" || typeof values === "number" ? [values] : [...values],
        duration: options.duration * 1000,
        onComplete: () => {
          remaining -= 1;
          if (remaining === 0) options.onComplete?.();
        },
      }),
  );
  for (const { element } of targets)
    for (const animation of element.getAnimations()) void animation.finished.catch(() => undefined);
  return new GroupAnimationWithThen(animations);
}
