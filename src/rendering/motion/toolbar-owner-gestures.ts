import { registerKeyboardPress } from "./keyboard-press";

export function bindOwnerGestures(
  element: HTMLButtonElement,
  disabled: boolean,
  publish: (state: { local: boolean; gesture: string; hovering: boolean }) => void,
  local: boolean,
): (() => void) | undefined {
  const ownerWindow = element.ownerDocument.defaultView!;
  let hovering = false;
  let keyPressing = false;
  let pointerId: number | undefined;
  const update = (): void =>
    publish({
      local,
      hovering,
      gesture: pointerId !== undefined || keyPressing ? "press" : hovering ? "hover" : "rest",
    });
  update();
  if (disabled) return;
  const stopKeyboard = registerKeyboardPress(
    element,
    () => {
      if (element.disabled) return undefined;
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
    if (element.disabled) return;
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
    if (element.disabled || event.button !== 0 || !event.isPrimary) return;
    pointerId = event.pointerId;
    if (event.pointerType === "touch") hovering = false;
    update();
  };
  const end = (event: PointerEvent): void => {
    if (pointerId === event.pointerId) {
      pointerId = undefined;
      if (event.type !== "pointerup") hovering = false;
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
  element.addEventListener("blur", blur);
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
    element.removeEventListener("blur", blur);
    ownerWindow.removeEventListener("pointerup", end);
    ownerWindow.removeEventListener("pointercancel", end);
    ownerWindow.removeEventListener("blur", blur);
    ownerWindow.removeEventListener("pagehide", blur);
  };
}
