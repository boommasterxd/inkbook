import { MAX_ABSOLUTE_COORDINATE } from "../../domain/schema/public";

import type { InputState, PointerDownAction, PointerSample } from "./input-types";

type PenPointerRole = "normal" | "eraser" | "side-button";

interface PointerDownClassificationInput {
  readonly button: number;
  readonly buttons: number;
  readonly controlKey: boolean;
  readonly controlOrMeta: boolean;
  readonly isMacPlatform: boolean;
  readonly isPrimary: boolean;
  readonly pointerType: PointerSample["pointerType"];
}

interface PointerDownClassification {
  readonly handleEligible: boolean;
  readonly isPlatformContextClick: boolean;
  readonly penRole: PenPointerRole;
}

export function classifyPointerDown(
  input: PointerDownClassificationInput,
): PointerDownClassification {
  const penRole = classifyPenRole(input);
  const isPlatformContextClick =
    input.pointerType === "mouse" &&
    penRole === "normal" &&
    (input.button === 2 || (input.button === 0 && input.controlKey && input.isMacPlatform));
  const normalPrimary =
    input.isPrimary &&
    input.button === 0 &&
    input.buttons === 1 &&
    !input.controlOrMeta &&
    !isPlatformContextClick &&
    penRole === "normal";
  return { handleEligible: normalPrimary, isPlatformContextClick, penRole };
}

export function isValidPointerDown(action: PointerDownAction): boolean {
  return (
    Number.isSafeInteger(action.button) &&
    action.button >= 0 &&
    Number.isSafeInteger(action.buttons) &&
    action.buttons >= 0 &&
    isValidPointerSample(action)
  );
}

export function isValidPointerSample(value: PointerSample): boolean {
  return (
    Number.isSafeInteger(value.pointerId) &&
    value.pointerId >= 0 &&
    isValidInputPoint(value) &&
    (value.pressure === undefined ||
      (Number.isFinite(value.pressure) && value.pressure >= 0 && value.pressure <= 1))
  );
}

export function isValidInputPoint(value: Pick<PointerSample, "x" | "y">): boolean {
  return isBoundedCoordinate(value.x) && isBoundedCoordinate(value.y);
}

export function classifyPenRole(
  input: Pick<PointerDownClassificationInput, "pointerType" | "button" | "buttons">,
): PenPointerRole {
  if (input.pointerType !== "pen" && input.pointerType !== "mouse") return "normal";
  if ((input.buttons & 32) !== 0 || (input.button === 5 && input.buttons !== 0)) return "eraser";
  if (input.pointerType !== "pen") return "normal";
  if ((input.buttons & 6) !== 0) return "side-button";
  // A contact-only mask can accompany a chorded release of the side button.
  if (input.buttons !== 0 && (input.buttons & 1) === 0) {
    if (input.button === 1 || input.button === 2) return "side-button";
  }
  return "normal";
}

export function hasPenContact(input: {
  readonly buttons: number;
  readonly pressure?: number;
}): boolean {
  return (input.pressure ?? 0) > 0 || (input.buttons & 33) !== 0;
}

export function usesPenContactLifecycle(
  pointer: { readonly pointerId: number; readonly pointerType: string },
  role: PenPointerRole,
  interaction: InputState["interaction"],
): boolean {
  return (
    pointer.pointerType === "pen" ||
    (pointer.pointerType === "mouse" &&
      (role === "eraser" ||
        (interaction !== undefined &&
          interaction.phase !== "pinch" &&
          interaction.pointerType === "mouse" &&
          interaction.penRole === "eraser" &&
          interaction.pointerId === pointer.pointerId)))
  );
}

function isBoundedCoordinate(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_ABSOLUTE_COORDINATE;
}
