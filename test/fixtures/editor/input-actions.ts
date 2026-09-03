import {
  type InputEffect,
  type InputState,
  type PointerDownAction,
  type PointerMoveAction,
} from "../../../src/editor/input/input-types";

export function effectTypes(effects: readonly InputEffect[]): string[] {
  return effects.map(({ type }) => type);
}

export function inputPhase(state: InputState): string {
  return state.interaction?.phase ?? "idle";
}

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

export function pointerMove(overrides: Partial<PointerMoveAction> = {}): PointerMoveAction {
  return {
    type: "pointer-move",
    pointerId: 1,
    pointerType: "mouse",
    x: 20,
    y: 30,
    pressure: 0.5,
    ...overrides,
  };
}
