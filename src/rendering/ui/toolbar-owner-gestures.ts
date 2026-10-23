import { useLayoutEffect, useState } from "react";
import type { RefObject } from "react";

/** Motion 14.6 listens for gesture ends on its module window, which can differ in a pop-out. */
export function useToolbarOwnerGestures(
  elementRef: RefObject<HTMLButtonElement | null>,
  disabled: boolean,
) {
  const [state, setState] = useState({ local: false, gesture: "rest" });
  useLayoutEffect(() => {
    const element = elementRef.current;
    const ownerWindow = element?.ownerDocument.defaultView;
    if (
      element === null ||
      ownerWindow === undefined ||
      ownerWindow === null ||
      ownerWindow === window
    )
      return;
    return bindOwnerGestures(element, disabled, setState);
  }, [disabled, elementRef]);
  return state;
}

function bindOwnerGestures(
  element: HTMLButtonElement,
  disabled: boolean,
  publish: (state: { local: boolean; gesture: string }) => void,
): (() => void) | undefined {
  const ownerWindow = element.ownerDocument.defaultView!;
  let hovering = false;
  let keyPressing = false;
  let pointerId: number | undefined;
  const update = (): void =>
    publish({
      local: true,
      gesture: pointerId !== undefined || keyPressing ? "press" : hovering ? "hover" : "rest",
    });
  update();
  if (disabled) return;
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
  const keyDown = (event: KeyboardEvent): void => {
    if (event.key === "Enter" && !event.repeat) {
      keyPressing = true;
      update();
    }
  };
  const keyUp = (event?: KeyboardEvent): void => {
    if (event !== undefined && event.key !== "Enter") return;
    keyPressing = false;
    update();
  };
  const elementBlur = (): void => keyUp();
  element.addEventListener("pointerenter", enter);
  element.addEventListener("pointerleave", leave);
  element.addEventListener("pointerdown", down);
  element.addEventListener("lostpointercapture", end);
  element.addEventListener("keydown", keyDown);
  element.addEventListener("keyup", keyUp);
  element.addEventListener("blur", elementBlur);
  ownerWindow.addEventListener("pointerup", end);
  ownerWindow.addEventListener("pointercancel", end);
  ownerWindow.addEventListener("blur", blur);
  return () => {
    element.removeEventListener("pointerenter", enter);
    element.removeEventListener("pointerleave", leave);
    element.removeEventListener("pointerdown", down);
    element.removeEventListener("lostpointercapture", end);
    element.removeEventListener("keydown", keyDown);
    element.removeEventListener("keyup", keyUp);
    element.removeEventListener("blur", elementBlur);
    ownerWindow.removeEventListener("pointerup", end);
    ownerWindow.removeEventListener("pointercancel", end);
    ownerWindow.removeEventListener("blur", blur);
  };
}
