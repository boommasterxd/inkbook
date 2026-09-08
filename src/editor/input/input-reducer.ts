import {
  ELEMENT_DRAG_THRESHOLD_PX,
  TOUCH_AXIS_LOCK_THRESHOLD_PX,
  type ConfigureInputAction,
  type ContextMenuAction,
  type InputAction,
  type InputEffect,
  type InputInteraction,
  type InputReduction,
  type InputState,
  type PinchInteraction,
  type PointerDownAction,
  type PointerMoveAction,
  type TouchPendingInteraction,
} from "./input-types";
import {
  beginPinch,
  cancelInteraction,
  handleLongPress,
  handlePointerExit,
  updatePinch,
} from "./input-pointer-lifecycle";
import {
  beginPreview,
  combine,
  delta,
  distance,
  fingerDrawingEnabled,
  hasActiveNormalPen,
  interactionBase,
  isFinitePoint,
  isReservedContextPointer,
  isSingleTouch,
  isTouchInteraction,
  longPressEffect,
  movementEffect,
  penRole,
  point,
  previewKind,
  sample,
  unchangedEffects,
  updateCurrent,
  usesTemporaryEraser,
  validPositive,
  withInteraction,
} from "./input-reducer-operations";
import { isValidPointerDown, isValidPointerSample } from "./pointer-validation";

export function reduceInput(state: InputState, action: InputAction): InputReduction {
  switch (action.type) {
    case "configure":
      return configure(state, action);
    case "reset":
      return reset(state);
    case "context-menu":
      return openContextMenu(state, action);
    case "long-press":
      return handleLongPress(state, action);
    case "lost-pointer-capture":
    case "pointer-cancel":
    case "pointer-up":
      return handlePointerExit(state, action);
    case "pointer-down":
      return handlePointerDown(state, action);
    case "pointer-move":
      return handlePointerMove(state, action);
  }
}

function reset(state: InputState): InputReduction {
  if (state.interaction === undefined) {
    return { state: { ...state, consumedPointerIds: [] }, effects: [] };
  }
  const cancelled = cancelInteraction(state, state.interaction, false);
  return {
    state: { ...cancelled.state, consumedPointerIds: [] },
    effects: cancelled.effects,
  };
}

function configure(state: InputState, action: ConfigureInputAction): InputReduction {
  const next = {
    ...state,
    activeTool: action.activeTool ?? state.activeTool,
    deviceFingerDrawingEnabled:
      action.deviceFingerDrawingEnabled ?? state.deviceFingerDrawingEnabled,
    toolbarFingerDrawingEnabled:
      action.toolbarFingerDrawingEnabled ?? state.toolbarFingerDrawingEnabled,
    hasSelection: action.hasSelection ?? state.hasSelection,
    zoom: validPositive(action.zoom) ? action.zoom : state.zoom,
    fitZoom: validPositive(action.fitZoom) ? action.fitZoom : state.fitZoom,
  };
  return unchangedEffects(next);
}

function openContextMenu(state: InputState, action: ContextMenuAction): InputReduction {
  if (state.interaction !== undefined || !isFinitePoint(action)) {
    return unchangedEffects(state);
  }
  const effects: InputEffect[] = [];
  if (action.source === "pointer" && action.target !== undefined && !action.target.isSelected) {
    effects.push({
      type: "select-element",
      elementId: action.target.elementId,
      mode: "replace",
    });
  }
  effects.push({
    type: "open-context-menu",
    source: action.source,
    position: point(action),
  });
  return { state, effects };
}

function handlePointerDown(state: InputState, action: PointerDownAction): InputReduction {
  if (!isValidPointerDown(action) || state.consumedPointerIds.includes(action.pointerId)) {
    return unchangedEffects(state);
  }
  if (action.pointerType === "touch" && hasActiveNormalPen(state.interaction)) {
    return unchangedEffects(state);
  }
  if (action.pointerType === "pen" && isTouchInteraction(state.interaction)) {
    const cancelled = cancelInteraction(state, state.interaction, true);
    return combine(cancelled, startSinglePointer(cancelled.state, action));
  }
  if (action.pointerType === "touch" && isSingleTouch(state.interaction)) {
    return beginPinch(state, state.interaction, action);
  }
  if (state.interaction !== undefined || isReservedContextPointer(action)) {
    return unchangedEffects(state);
  }
  if (action.pointerType === "mouse" && (action.button !== 0 || action.buttons !== 1)) {
    return unchangedEffects(state);
  }
  if (
    action.pointerType === "pen" &&
    penRole(action) === "normal" &&
    (action.button !== 0 || action.buttons !== 1)
  ) {
    return unchangedEffects(state);
  }
  return startSinglePointer(state, action);
}

function startSinglePointer(state: InputState, action: PointerDownAction): InputReduction {
  const temporaryEraser = state.activeTool !== "select" && usesTemporaryEraser(action);
  const tool = temporaryEraser ? "eraser" : state.activeTool;
  const selectionCleared = shouldClearSelectionAtPointerDown(state, action, tool);
  const inputState = selectionCleared ? { ...state, hasSelection: false } : state;
  const base = interactionBase(action, tool, state.activeTool, temporaryEraser);
  const capture: InputEffect[] = [{ type: "capture-pointer", pointerId: action.pointerId }];
  if (selectionCleared) capture.push({ type: "clear-selection" });
  if (temporaryEraser) {
    capture.push({ type: "activate-temporary-eraser", previousTool: state.activeTool });
  }
  if (!temporaryEraser && action.target?.isSelected === true) {
    const isTouch = action.pointerType === "touch";
    return startElementMove(inputState, base, action.target.elementId, capture, isTouch, true);
  }
  if (action.pointerType === "touch" && action.target !== undefined) {
    const interaction: TouchPendingInteraction = {
      ...base,
      phase: "touch-pending",
      longPressScheduled: true,
      target: action.target,
    };
    capture.push(longPressEffect(action.pointerId));
    return withInteraction(inputState, interaction, capture);
  }
  if (action.pointerType === "touch" && (tool === "select" || !fingerDrawingEnabled(state))) {
    const interaction: InputInteraction = {
      ...base,
      phase: "touch-pending",
      longPressScheduled: true,
    };
    capture.push(longPressEffect(action.pointerId));
    return withInteraction(inputState, interaction, capture);
  }
  if (tool === "select" && action.target !== undefined) {
    return startElementMove(
      inputState,
      base,
      action.target.elementId,
      capture,
      false,
      action.target.isSelected,
    );
  }
  if (tool === "select") {
    return withInteraction(inputState, { ...base, phase: "lasso" }, capture);
  }
  const phase = tool === "eraser" ? "eraser-gesture" : "tool-gesture";
  const interaction: InputInteraction = { ...base, phase, previewStarted: true };
  capture.push({
    type: "begin-preview",
    kind: phase,
    tool,
    pointer: sample(action),
    additive: false,
  });
  return withInteraction(inputState, interaction, capture);
}

function shouldClearSelectionAtPointerDown(
  state: InputState,
  action: PointerDownAction,
  tool: InputState["activeTool"],
): boolean {
  if (
    !state.hasSelection ||
    (action.shift && tool === "select") ||
    action.target?.isSelected === true ||
    (action.pointerType === "touch" && action.target !== undefined)
  )
    return false;
  if (tool === "select" && action.target !== undefined) return false;
  if (action.pointerType === "touch") {
    return tool !== "select" && fingerDrawingEnabled(state);
  }
  return (
    action.button === 0 &&
    action.buttons === 1 &&
    !action.controlOrMeta &&
    penRole(action) === "normal"
  );
}

function startElementMove(
  state: InputState,
  base: ReturnType<typeof interactionBase>,
  elementId: string,
  effects: InputEffect[],
  isTouch: boolean,
  isSelected: boolean,
): InputReduction {
  const interaction: InputInteraction = {
    ...base,
    phase: "element-move",
    elementId,
    longPressScheduled: isTouch,
  };
  if (!isSelected) {
    effects.push({
      type: "select-element",
      elementId,
      mode: base.controlOrMeta ? "add" : "replace",
    });
  }
  if (isTouch) {
    effects.push(longPressEffect(base.pointerId));
  }
  return withInteraction(state, interaction, effects);
}

function handlePointerMove(state: InputState, action: PointerMoveAction): InputReduction {
  if (!isValidPointerSample(action) || state.consumedPointerIds.includes(action.pointerId)) {
    return unchangedEffects(state);
  }
  const interaction = state.interaction;
  if (interaction === undefined) {
    return unchangedEffects(state);
  }
  if (interaction.phase === "pinch") {
    return updatePinch(state, interaction, action);
  }
  if (interaction.pointerId !== action.pointerId) {
    return unchangedEffects(state);
  }
  if (interaction.phase === "touch-pending") {
    return movePendingTouch(state, interaction, action);
  }
  if (interaction.phase === "note-scroll" || interaction.phase === "page-pan") {
    return moveNavigation(state, interaction, action);
  }
  return movePreview(state, interaction, action);
}

function movePendingTouch(
  state: InputState,
  interaction: TouchPendingInteraction,
  action: PointerMoveAction,
): InputReduction {
  const total = delta(interaction.start, action);
  if (distance(total) <= TOUCH_AXIS_LOCK_THRESHOLD_PX) {
    return updateCurrent(state, interaction, action, []);
  }
  const horizontal = Math.abs(total.x) > Math.abs(total.y);
  const phase = horizontal ? "page-pan" : "note-scroll";
  const movement = movementEffect(phase, delta(interaction.current, action));
  const changed: InputInteraction =
    phase === "page-pan"
      ? {
          ...interaction,
          phase: "page-pan",
          current: point(action),
          longPressScheduled: false,
        }
      : {
          ...interaction,
          phase: "note-scroll",
          current: point(action),
          longPressScheduled: false,
        };
  return withInteraction(state, changed, [
    { type: "cancel-long-press", pointerId: action.pointerId },
    movement,
  ]);
}

function moveNavigation(
  state: InputState,
  interaction: Exclude<InputInteraction, PinchInteraction>,
  action: PointerMoveAction,
): InputReduction {
  const effect = movementEffect(interaction.phase, delta(interaction.current, action));
  return updateCurrent(state, interaction, action, [effect]);
}

function movePreview(
  state: InputState,
  interaction: Exclude<InputInteraction, PinchInteraction>,
  action: PointerMoveAction,
): InputReduction {
  const kind = previewKind(interaction);
  if (kind === undefined) {
    return unchangedEffects(state);
  }
  const movement = distance(delta(interaction.start, action));
  const needsThreshold = kind === "element-move" || kind === "lasso";
  if (needsThreshold && !interaction.previewStarted && movement <= ELEMENT_DRAG_THRESHOLD_PX) {
    return updateCurrent(state, interaction, action, []);
  }
  const effects: InputEffect[] = [];
  if (interaction.longPressScheduled) {
    effects.push({ type: "cancel-long-press", pointerId: interaction.pointerId });
  }
  if (!interaction.previewStarted) {
    effects.push(beginPreview(interaction, action));
    effects.push({ type: "update-preview", kind, pointer: sample(action) });
  } else {
    effects.push({ type: "update-preview", kind, pointer: sample(action) });
  }
  const next = {
    ...interaction,
    current: point(action),
    previewStarted: true,
    longPressScheduled: false,
  };
  return withInteraction(state, next, effects);
}
