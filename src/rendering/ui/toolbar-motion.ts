import { createContext, useLayoutEffect, useState } from "react";
import type { RefObject } from "react";
import type { Transition } from "motion/react";

import { isReducedMotion, STANDARD_EASING, TRANSITION_DURATIONS } from "../motion/transitions";
import { createChromePalette, sameChromeColors, type ChromeColors } from "./chrome-palette";

export interface ToolbarMotionState {
  readonly colors?: ChromeColors | undefined;
  readonly foreignWindow?: boolean;
  readonly locking: boolean;
  readonly preparing: boolean;
  readonly reduced: boolean;
}

const initialMotion: ToolbarMotionState = { locking: false, preparing: false, reduced: false };
export const toolbarMotionContext = createContext(initialMotion);

export function toolbarLayoutTransition(reduced: boolean): Transition {
  return {
    type: "tween",
    duration: reduced ? 0 : TRANSITION_DURATIONS.toolActiveState / 1000,
    ease: STANDARD_EASING,
  };
}

/** Subscribe only to presentation lifecycle/preferences, never pointer or camera updates. */
export function useToolbarMotion(elementRef: RefObject<HTMLElement | null>): ToolbarMotionState {
  const [state, setState] = useState(initialMotion);
  useLayoutEffect(() => {
    const root = elementRef.current?.closest<HTMLElement>(".inkbook-root");
    const ownerWindow = elementRef.current?.ownerDocument.defaultView;
    if (ownerWindow === null || ownerWindow === undefined) return;
    const query = ownerWindow.matchMedia?.("(prefers-reduced-motion: reduce)");
    const palette = createChromePalette(elementRef.current!);
    const update = (): void => {
      const preference = root?.dataset.inkbookMotion;
      const next = {
        colors: palette.read(),
        locking: root?.dataset.inkbookState === "locking",
        preparing: root?.classList.contains("inkbook-active-preparing") === true,
        reduced: isReducedMotion(
          preference === "full" || preference === "reduced" ? preference : "system",
          query?.matches === true,
        ),
      };
      setState((previous) =>
        previous.locking === next.locking &&
        previous.preparing === next.preparing &&
        previous.reduced === next.reduced &&
        sameChromeColors(previous.colors, next.colors)
          ? previous
          : next,
      );
    };
    const observer = new ownerWindow.MutationObserver(update);
    if (root !== null && root !== undefined) {
      observer.observe(root, {
        attributes: true,
        attributeFilter: [
          "class",
          "data-inkbook-motion",
          "data-inkbook-state",
          "data-inkbook-scheme",
        ],
      });
    }
    for (const target of [ownerWindow.document.documentElement, ownerWindow.document.body])
      observer.observe(target, { attributes: true, attributeFilter: ["class", "style"] });
    query?.addEventListener("change", update);
    update();
    return () => {
      observer.disconnect();
      query?.removeEventListener("change", update);
      palette.dispose();
    };
  }, [elementRef]);
  return state;
}
