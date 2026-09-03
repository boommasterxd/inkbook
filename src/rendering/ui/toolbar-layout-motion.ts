import { useEffect, useLayoutEffect, useRef } from "react";

import {
  EASING_TOKENS,
  getMotionDuration,
  isReducedMotion,
  MOTION_TOKENS,
  type MotionPreference,
} from "../motion/transitions";
import type { ToolbarAction } from "./toolbar-types";

export type ToolbarButtonMap = Map<ToolbarAction, HTMLButtonElement>;

export function useToolbarLayoutMotion(
  layoutKey: string,
  buttonElements: { readonly current: ToolbarButtonMap },
): void {
  const previousOffsets = useRef<ReadonlyMap<ToolbarAction, number>>(new Map());
  const animations = useRef(new Map<ToolbarAction, Animation>());
  useLayoutEffect(() => {
    const nextOffsets = new Map<ToolbarAction, number>();
    for (const [action, element] of buttonElements.current) {
      const next = element.offsetLeft;
      nextOffsets.set(action, next);
      const previous = previousOffsets.current.get(action);
      if (previous === undefined || previous === next || typeof element.animate !== "function") {
        continue;
      }
      animations.current.get(action)?.cancel();
      const duration = toolbarLayoutDuration(element);
      if (duration === 0) continue;
      animations.current.set(
        action,
        element.animate([{ translate: `${String(previous - next)}px 0` }, { translate: "0 0" }], {
          duration,
          easing: EASING_TOKENS.standard,
        }),
      );
    }
    previousOffsets.current = nextOffsets;
  }, [layoutKey]);
  useEffect(
    () => () => {
      for (const animation of animations.current.values()) animation.cancel();
      animations.current.clear();
    },
    [],
  );
}

export function useToolbarElementLayoutMotion(
  layoutKey: string | undefined,
  elementRef: { readonly current: HTMLElement | null },
): void {
  const previousLeft = useRef<number | null>(null);
  const animation = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    if (layoutKey === undefined) return;
    const element = elementRef.current;
    if (element === null) return;
    const next = element.getBoundingClientRect().left;
    const previous = previousLeft.current;
    previousLeft.current = next;
    if (previous === null || previous === next || typeof element.animate !== "function") return;
    animation.current?.cancel();
    const duration = toolbarLayoutDuration(element);
    if (duration === 0) return;
    animation.current = element.animate(
      [{ translate: `${String(previous - next)}px 0` }, { translate: "0 0" }],
      { duration, easing: EASING_TOKENS.standard },
    );
  }, [layoutKey]);
  useEffect(
    () => () => {
      animation.current?.cancel();
    },
    [],
  );
}

function toolbarLayoutDuration(element: HTMLElement): number {
  const root = element.closest<HTMLElement>(".inkbook-root");
  const preference = motionPreference(root?.dataset.inkbookMotion);
  const ownerWindow = element.ownerDocument.defaultView;
  const systemReduced =
    ownerWindow?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  return getMotionDuration(MOTION_TOKENS.fast, isReducedMotion(preference, systemReduced));
}

function motionPreference(value: string | undefined): MotionPreference {
  return value === "full" || value === "reduced" ? value : "system";
}
