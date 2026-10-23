import { motion } from "motion/react";
import { forwardRef, useImperativeHandle, type ForwardedRef, type ReactNode } from "react";

export interface SettingsMotionBoundary {
  readonly element: HTMLElement;
  readonly children: SettingsMotionBoundary[];
  readonly key: number;
  readonly transform: string;
  readonly transformOrigin: string;
}

/** Projects existing native elements without replacing their DOM or focus ownership. */
const ExistingElement = forwardRef(function ExistingElement(
  { element, children }: { element: HTMLElement; children?: ReactNode },
  ref: ForwardedRef<HTMLElement>,
) {
  useImperativeHandle(ref, () => element, [element]);
  return children;
});

export const ExistingSettingsMotion = motion.create(ExistingElement);

export function settingsMotionBoundaries(
  container: HTMLElement,
  selector: string,
  previous: readonly SettingsMotionBoundary[] = [],
): SettingsMotionBoundary[] {
  const roots: SettingsMotionBoundary[] = [];
  const byElement = new Map<HTMLElement, SettingsMotionBoundary>();
  const originals = new Map<HTMLElement, SettingsMotionBoundary>();
  const collect = (boundaries: readonly SettingsMotionBoundary[]): void => {
    for (const boundary of boundaries) {
      originals.set(boundary.element, boundary);
      collect(boundary.children);
    }
  };
  collect(previous);
  let nextKey = Math.max(-1, ...[...originals.values()].map((boundary) => boundary.key)) + 1;
  const elements = [...container.querySelectorAll<HTMLElement>(selector)];
  if (container.matches(selector)) elements.unshift(container);
  for (const element of elements) {
    const original = originals.get(element);
    const boundary: SettingsMotionBoundary = {
      element,
      children: [],
      key: original?.key ?? nextKey++,
      transform: original?.transform ?? element.style.transform,
      transformOrigin: original?.transformOrigin ?? element.style.transformOrigin,
    };
    byElement.set(element, boundary);
    const parent = element.parentElement?.closest<HTMLElement>(selector);
    (parent === null || parent === undefined
      ? roots
      : (byElement.get(parent)?.children ?? roots)
    ).push(boundary);
  }
  return roots;
}

export function restoreSettingsMotionBoundaries(
  boundaries: readonly SettingsMotionBoundary[],
): void {
  for (const boundary of boundaries) {
    boundary.element.style.setProperty("transform", boundary.transform);
    boundary.element.style.setProperty("transform-origin", boundary.transformOrigin);
    restoreSettingsMotionBoundaries(boundary.children);
  }
}

export function guardCanceledSettingsAnimations(element: HTMLElement): void {
  for (const animation of element.getAnimations({ subtree: true })) {
    void animation.finished.catch(() => undefined);
  }
}
