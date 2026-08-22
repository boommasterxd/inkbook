import { MAX_ABSOLUTE_COORDINATE } from "../../domain/schema/public";

import type { PointerDownAction, PointerSample } from "./input-types";

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
    (input.button === 2 || (input.button === 0 && input.controlKey && input.isMacPlatform));
  const normalPrimary =
    input.isPrimary &&
    input.button === 0 &&
    input.buttons === 1 &&
    !input.controlOrMeta &&
    !isPlatformContextClick &&
    (input.pointerType !== "pen" || penRole === "normal");
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

function classifyPenRole(input: PointerDownClassificationInput): PenPointerRole {
  if (input.pointerType !== "pen") return "normal";
  if (input.button === 5 || input.buttons === 32) return "eraser";
  if (input.button === 2 || input.buttons === 2) return "side-button";
  return "normal";
}

function isBoundedCoordinate(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_ABSOLUTE_COORDINATE;
}
