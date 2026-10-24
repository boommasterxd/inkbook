import { useLayoutEffect, useState } from "react";
import type { RefObject } from "react";

import { registerKeyboardPress } from "../motion/keyboard-press";

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

function bindOwnerGestures(
  element: HTMLButtonElement,
  disabled: boolean,
  publish: (state: { local: boolean; gesture: string }) => void,
  local: boolean,
): (() => void) | undefined {
  const ownerWindow = element.ownerDocument.defaultView!;
  let hovering = false;
  let keyPressing = false;
  let pointerId: number | undefined;
  const update = (): void =>
    publish({
      local,
      gesture: pointerId !== undefined || keyPressing ? "press" : hovering ? "hover" : "rest",
    });
  update();
  if (disabled) return;
  const stopKeyboard = registerKeyboardPress(
    element,
    () => {
      keyPressing = true;
      update();
      return () => {
        keyPressing = false;
        update();
      };
    },
    local,
  );
  if (!local) return stopKeyboard;
  const enter = (event: PointerEvent): void => {
    if (event.pointerType !== "touch") {
      hovering = true;
      update();
    }
  };
  const leave = (): void => {
    hovering = false;
    update();
  };
  const down = (event: PointerEvent): void => {
    if (event.button !== 0 || !event.isPrimary) return;
    pointerId = event.pointerId;
    if (event.pointerType === "touch") hovering = false;
    update();
  };
  const end = (event: PointerEvent): void => {
    if (pointerId === event.pointerId) {
      pointerId = undefined;
      update();
    }
  };
  const blur = (): void => {
    pointerId = undefined;
    keyPressing = false;
    hovering = false;
    update();
  };
  element.addEventListener("pointerenter", enter);
  element.addEventListener("pointerleave", leave);
  element.addEventListener("pointerdown", down);
  element.addEventListener("lostpointercapture", end);
  ownerWindow.addEventListener("pointerup", end);
  ownerWindow.addEventListener("pointercancel", end);
  ownerWindow.addEventListener("blur", blur);
  ownerWindow.addEventListener("pagehide", blur);
  return () => {
    stopKeyboard();
    element.removeEventListener("pointerenter", enter);
    element.removeEventListener("pointerleave", leave);
    element.removeEventListener("pointerdown", down);
    element.removeEventListener("lostpointercapture", end);
    ownerWindow.removeEventListener("pointerup", end);
    ownerWindow.removeEventListener("pointercancel", end);
    ownerWindow.removeEventListener("blur", blur);
    ownerWindow.removeEventListener("pagehide", blur);
  };
}
