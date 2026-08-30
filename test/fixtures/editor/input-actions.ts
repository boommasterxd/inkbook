import type { PointerDownAction } from "../../../src/editor/input";

export function pointerDown(overrides: Partial<PointerDownAction> = {}): PointerDownAction {
  return {
    type: "pointer-down",
    pointerId: 1,
    pointerType: "mouse",
    x: 10,
    y: 20,
    pressure: 0.5,
    button: 0,
    buttons: 1,
    controlOrMeta: false,
    shift: false,
    isPlatformContextClick: false,
    ...overrides,
  };
}
