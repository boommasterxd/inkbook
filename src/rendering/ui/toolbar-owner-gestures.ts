import { useLayoutEffect, useState } from "react";
import type { RefObject } from "react";

import { bindOwnerGestures } from "../motion/toolbar-owner-gestures";

/** Complements Motion 14.6 Space presses and gesture ends in a pop-out's owning window. */
export function useToolbarOwnerGestures(
  elementRef: RefObject<HTMLElement | null>,
  disabled: boolean,
) {
  const [state, setState] = useState({ local: false, gesture: "rest" });
  useLayoutEffect(() => {
    const element = elementRef.current?.closest<HTMLButtonElement>("button") ?? null;
    const ownerWindow = element?.ownerDocument.defaultView;
    if (element === null || ownerWindow === undefined || ownerWindow === null) return;
    return bindOwnerGestures(element, disabled, setState, ownerWindow !== window);
  }, [disabled, elementRef]);
  return state;
}
