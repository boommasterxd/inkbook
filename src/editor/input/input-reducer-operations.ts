import {
  LONG_PRESS_DELAY_MS,
  type EditorTool,
  type InputEffect,
  type InputInteraction,
  type InputPoint,
  type InputReduction,
  type InputState,
  type PinchInteraction,
  type PointerDownAction,
  type PointerMoveAction,
  type PointerSample,
  type PreviewKind,
} from "./input-types";

export function interactionBase(
  action: PointerDownAction,
  tool: EditorTool,
  previousTool: EditorTool,
  temporaryEraser: boolean,
) {
  return {
    pointerId: action.pointerId,
    pointerType: action.pointerType,
    penRole: penRole(action),
    controlOrMeta: action.controlOrMeta,
    start: point(action),
    ...(validTimestamp(action.timestamp) ? { startedAt: action.timestamp } : {}),
    current: point(action),
    previewStarted: false,
    longPressScheduled: false,
    temporaryEraser,
    previousTool,
    tool,
    shift: action.shift,
  } as const;
}

export function cleanupEffects(
  interaction: Exclude<InputInteraction, PinchInteraction>,
): InputEffect[] {
  const effects = cancelLongPressEffects(interaction);
  effects.push({ type: "release-pointer", pointerId: interaction.pointerId });
  if (interaction.temporaryEraser) {
    effects.push({ type: "restore-temporary-tool", tool: interaction.previousTool });
  }
  return effects;
}

export function cancelLongPressEffects(
  interaction: Exclude<InputInteraction, PinchInteraction>,
): InputEffect[] {
  return interaction.longPressScheduled
    ? [{ type: "cancel-long-press", pointerId: interaction.pointerId }]
    : [];
}

export function beginPreview(
  interaction: Exclude<InputInteraction, PinchInteraction>,
  pointer: PointerSample,
): InputEffect {
  const kind = previewKind(interaction);
  if (kind === undefined) {
    throw new Error("A non-preview interaction cannot begin a preview.");
  }
  return {
    type: "begin-preview",
    kind,
    tool: interaction.tool,
    pointer: { ...sample(pointer), x: interaction.start.x, y: interaction.start.y },
    additive: interaction.phase === "lasso" && interaction.shift,
  };
}

export function previewKind(
  interaction: Exclude<InputInteraction, PinchInteraction>,
): PreviewKind | undefined {
  switch (interaction.phase) {
    case "element-move":
    case "eraser-gesture":
    case "lasso":
    case "tool-gesture":
      return interaction.phase;
    case "note-scroll":
    case "page-pan":
    case "touch-pending":
    case "select-pending":
      return undefined;
  }
}

export function shouldClearSelectionForTouchPreview(
  interaction: Exclude<InputInteraction, PinchInteraction>,
): boolean {
  return (
    interaction.pointerType === "touch" &&
    !interaction.shift &&
    interaction.phase !== "element-move"
  );
}

export function movementEffect(
  phase: Exclude<InputInteraction, PinchInteraction>["phase"],
  movement: InputPoint,
): InputEffect {
  return phase === "page-pan"
    ? { type: "pan-page", screenDeltaX: movement.x }
    : { type: "scroll-note", screenDeltaX: movement.x, screenDeltaY: movement.y };
}

export function updateCurrent(
  state: InputState,
  interaction: Exclude<InputInteraction, PinchInteraction>,
  action: PointerMoveAction,
  effects: readonly InputEffect[],
): InputReduction {
  return withInteraction(state, { ...interaction, current: point(action) }, effects);
}

export function withInteraction(
  state: InputState,
  interaction: InputInteraction,
  effects: readonly InputEffect[],
): InputReduction {
  return { state: { ...state, interaction }, effects };
}

export function combine(first: InputReduction, second: InputReduction): InputReduction {
  return { state: second.state, effects: [...first.effects, ...second.effects] };
}

export function unchangedEffects(state: InputState): InputReduction {
  return { state, effects: [] };
}

export function isReservedContextPointer(action: PointerDownAction): boolean {
  return action.pointerType === "mouse" && (action.button === 2 || action.isPlatformContextClick);
}

export function usesTemporaryEraser(action: PointerDownAction): boolean {
  if (action.pointerType === "pen" && penRole(action) !== "normal") {
    return true;
  }
  return (action.pointerType === "mouse" || action.pointerType === "pen") && action.controlOrMeta;
}

export function penRole(action: PointerDownAction): "normal" | "eraser" | "side-button" {
  return action.pointerType === "pen" ? (action.penRole ?? "normal") : "normal";
}

export function hasActiveNormalPen(interaction: InputInteraction | undefined): boolean {
  return (
    interaction !== undefined &&
    interaction.phase !== "pinch" &&
    interaction.pointerType === "pen" &&
    interaction.penRole === "normal"
  );
}

export function fingerDrawingEnabled(state: InputState): boolean {
  return state.deviceFingerDrawingEnabled && state.toolbarFingerDrawingEnabled;
}

export function isTouchInteraction(
  interaction: InputInteraction | undefined,
): interaction is InputInteraction {
  return interaction?.phase === "pinch" || isSingleTouch(interaction);
}

export function isSingleTouch(
  interaction: InputInteraction | undefined,
): interaction is Exclude<InputInteraction, PinchInteraction> {
  return (
    interaction !== undefined &&
    interaction.phase !== "pinch" &&
    interaction.pointerType === "touch"
  );
}

export function ownsPointer(interaction: InputInteraction, pointerId: number): boolean {
  return interaction.phase === "pinch"
    ? interaction.pointers.some((pointer) => pointer.pointerId === pointerId)
    : interaction.pointerId === pointerId;
}

export function pointerFromInteraction(
  interaction: Exclude<InputInteraction, PinchInteraction>,
): PointerSample {
  return {
    ...interaction.current,
    pointerId: interaction.pointerId,
    pointerType: interaction.pointerType,
  };
}

export function longPressEffect(pointerId: number): InputEffect {
  return { type: "schedule-long-press", pointerId, delayMs: LONG_PRESS_DELAY_MS };
}

export function sample(value: PointerSample): PointerSample {
  return {
    pointerId: value.pointerId,
    pointerType: value.pointerType,
    x: value.x,
    y: value.y,
    ...(value.pressure === undefined ? {} : { pressure: value.pressure }),
  };
}

export function midpoint(first: InputPoint, second: InputPoint): InputPoint {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

export function pointerDistance(pointers: readonly [InputPoint, InputPoint]): number {
  return distance(delta(pointers[0], pointers[1]));
}

export function delta(from: InputPoint, to: InputPoint): InputPoint {
  return { x: to.x - from.x, y: to.y - from.y };
}

export function distance(value: InputPoint): number {
  return Math.hypot(value.x, value.y);
}

export function point(value: InputPoint): InputPoint {
  return { x: value.x, y: value.y };
}

export function isFinitePoint(value: InputPoint): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y);
}

export function validPositive(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function validTimestamp(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

export function appendIds(
  existing: readonly number[],
  added: readonly number[],
): readonly number[] {
  return [...new Set([...existing, ...added])];
}

export function removeId(existing: readonly number[], removed: number): readonly number[] {
  return existing.filter((pointerId) => pointerId !== removed);
}
