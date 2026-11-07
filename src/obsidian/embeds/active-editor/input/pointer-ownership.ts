import type { InputState } from "../../../../editor/input/index";
import { touchInteractionBlocksNativeScroll } from "./controller-touch";

export function ownsSecondaryNavigation(
  interaction: InputState["interaction"],
): interaction is Extract<
  NonNullable<InputState["interaction"]>,
  { phase: "secondary-pending" | "page-pan" }
> {
  return (
    interaction !== undefined &&
    interaction.phase !== "pinch" &&
    interaction.pointerType === "mouse" &&
    (interaction.phase === "secondary-pending" || interaction.phase === "page-pan")
  );
}

export function ownsTouchPan(
  interaction: InputState["interaction"],
  pointerId: number,
): interaction is Extract<
  NonNullable<InputState["interaction"]>,
  { readonly phase: "page-pan" | "touch-pending" }
> {
  return (
    (interaction?.phase === "page-pan" || interaction?.phase === "touch-pending") &&
    interaction.pointerType === "touch" &&
    interaction.pointerId === pointerId
  );
}

export function interactionOwnsPointer(
  interaction: InputState["interaction"],
  pointerId: number,
): boolean {
  if (interaction === undefined) return false;
  return interaction.phase === "pinch"
    ? interaction.pointers.some((pointer) => pointer.pointerId === pointerId)
    : interaction.pointerId === pointerId;
}

export function claimsPointerGesture(
  event: PointerEvent,
  interaction: InputState["interaction"],
): boolean {
  return (
    interaction !== undefined &&
    (event.pointerType !== "touch" || touchInteractionBlocksNativeScroll(interaction))
  );
}
