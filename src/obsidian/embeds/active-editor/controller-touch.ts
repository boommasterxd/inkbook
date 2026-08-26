import type { InputState } from "../../../editor/input/index";

const TOUCH_PAN_RESPONSE = 1.2;

export function isTouchInteraction(interaction: InputState["interaction"]): boolean {
  return (
    interaction?.phase === "pinch" ||
    (interaction !== undefined && interaction.pointerType === "touch")
  );
}

export function touchInteractionOwnsPointer(
  interaction: InputState["interaction"],
  pointerId: number,
): boolean {
  if (!isTouchInteraction(interaction) || interaction === undefined) return false;
  return interaction.phase === "pinch"
    ? interaction.pointers.some((pointer) => pointer.pointerId === pointerId)
    : interaction.pointerId === pointerId;
}

export function touchInteractionBlocksNativeScroll(
  interaction: InputState["interaction"],
): boolean {
  return (
    isTouchInteraction(interaction) &&
    interaction !== undefined &&
    interaction.phase !== "touch-pending" &&
    interaction.phase !== "note-scroll" &&
    (interaction.phase !== "element-move" || interaction.previewStarted)
  );
}

export function touchPanDelta(screenDeltaX: number): number {
  return screenDeltaX * TOUCH_PAN_RESPONSE;
}
