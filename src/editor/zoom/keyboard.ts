import { zoomFactorForSteps } from "./zoom";

export interface KeyboardZoomInput {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly key: string;
  readonly metaKey: boolean;
}

export type KeyboardZoomStep = -1 | 1;

/**
 * Resolves platform zoom shortcuts without claiming unrelated Obsidian keys.
 * The adapter remains responsible for checking that the pointer is over the
 * active canvas before forwarding the event.
 */
export function keyboardZoomStep(input: KeyboardZoomInput): KeyboardZoomStep | undefined {
  if ((!input.ctrlKey && !input.metaKey) || input.altKey) return undefined;
  if (input.key === "+" || input.key === "=" || input.key === "Add") return 1;
  if (input.key === "-" || input.key === "_" || input.key === "Subtract") return -1;
  return undefined;
}

export function keyboardZoomFactor(input: KeyboardZoomInput): number | undefined {
  const step = keyboardZoomStep(input);
  return step === undefined ? undefined : zoomFactorForSteps(step);
}
