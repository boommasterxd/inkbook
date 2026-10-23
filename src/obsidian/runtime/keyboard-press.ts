import { press } from "motion";

/** Complements Motion 14.6 Enter-only press feedback without changing activation. */
export function registerKeyboardPress(
  element: HTMLElement,
  onPress: (event: KeyboardEvent) => (() => void) | undefined,
  includeEnter = false,
): () => void {
  const ownerWindow = element.ownerDocument.defaultView;
  let release: (() => void) | undefined;
  const accepts = (event: KeyboardEvent): boolean =>
    event.key === " " || (includeEnter && event.key === "Enter");
  const finish = (): void => {
    const current = release;
    release = undefined;
    ownerWindow?.removeEventListener("blur", finish);
    ownerWindow?.removeEventListener("pagehide", finish);
    current?.();
  };
  const down = (event: KeyboardEvent): void => {
    if (!accepts(event) || event.repeat || release !== undefined) return;
    release = onPress(event);
    if (release === undefined) return;
    ownerWindow?.addEventListener("blur", finish);
    ownerWindow?.addEventListener("pagehide", finish);
  };
  const up = (event: KeyboardEvent): void => {
    if (accepts(event)) finish();
  };
  element.addEventListener("keydown", down);
  element.addEventListener("keyup", up);
  element.addEventListener("blur", finish, true);
  return () => {
    element.removeEventListener("keydown", down);
    element.removeEventListener("keyup", up);
    element.removeEventListener("blur", finish, true);
    finish();
  };
}

/** Motion 14.6 needs its public cancel event when a held press loses window focus. */
export function registerOwnedMotionPress(
  elements: readonly HTMLElement[],
  onPressStart: (element: Element, event: PointerEvent) => (() => void) | undefined,
): () => void {
  const active = new Set<() => void>();
  const stopPress = press([...elements], (element, event) => {
    const end = onPressStart(element, event);
    const ownerWindow = element.ownerDocument.defaultView;
    if (ownerWindow === null) return end;
    const finish = (): void => {
      if (!active.delete(cancel)) return;
      ownerWindow.removeEventListener("blur", cancel);
      ownerWindow.removeEventListener("pagehide", cancel);
      end?.();
    };
    const cancel = (): void => {
      if (!active.has(cancel)) return;
      const pointerConstructor = (ownerWindow as Window & { PointerEvent: typeof PointerEvent })
        .PointerEvent;
      const target =
        element.isConnected && element.ownerDocument.defaultView === ownerWindow
          ? element
          : ownerWindow;
      try {
        target.dispatchEvent(
          new pointerConstructor("pointercancel", {
            bubbles: true,
            isPrimary: true,
            pointerId: event.pointerId,
            pointerType: event.pointerType,
            button: 0,
          }),
        );
      } finally {
        finish();
      }
    };
    active.add(cancel);
    ownerWindow.addEventListener("blur", cancel);
    ownerWindow.addEventListener("pagehide", cancel);
    return finish;
  });
  return () => {
    for (const cancel of [...active]) cancel();
    stopPress();
  };
}
