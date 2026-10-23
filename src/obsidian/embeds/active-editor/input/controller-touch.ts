import type { InputState } from "../../../../editor/input/index";

export function isTouchInteraction(interaction: InputState["interaction"]): boolean {
  return (
    interaction?.phase === "pinch" ||
    (interaction !== undefined && interaction.pointerType === "touch")
  );
}

export function touchTerminalNeedsRecovery(input: InputState, pointerId: number): boolean {
  if (input.consumedPointerIds.includes(pointerId)) return true;
  const interaction = input.interaction;
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
    interaction.phase !== "note-scroll"
  );
}
/** Touch compatibility menus must not replace the scheduler-owned long-press menu. */
export function isTouchCompatibilityEvent(event: MouseEvent): boolean {
  if (!("sourceCapabilities" in event)) return false;
  const capabilities = event.sourceCapabilities;
  return (
    capabilities !== null &&
    typeof capabilities === "object" &&
    "firesTouchEvents" in capabilities &&
    capabilities.firesTouchEvents === true
  );
}
