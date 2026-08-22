import {
  ELEMENT_DRAG_THRESHOLD_PX,
  EMPTY_TOUCH_THRESHOLD_PX,
  type InputEffect,
  type InputInteraction,
  type InputReduction,
  type InputState,
  type LongPressAction,
  type PinchInteraction,
  type PointerDownAction,
  type PointerExitAction,
  type PointerMoveAction,
  type PointerSample,
} from "./input-types";
import {
  appendIds,
  cancelLongPressEffects,
  cleanupEffects,
  delta,
  distance,
  midpoint,
  ownsPointer,
  pointerDistance,
  pointerFromInteraction,
  previewKind,
  removeId,
  sample,
  unchangedEffects,
} from "./input-reducer-operations";

export function handlePointerExit(state: InputState, action: PointerExitAction): InputReduction {
  if (state.consumedPointerIds.includes(action.pointerId)) {
    return {
      state: { ...state, consumedPointerIds: removeId(state.consumedPointerIds, action.pointerId) },
      effects: [],
    };
  }
  const interaction = state.interaction;
  if (interaction === undefined || !ownsPointer(interaction, action.pointerId)) {
    return unchangedEffects(state);
  }
  if (interaction.phase === "pinch") {
    return exitPinch(state, interaction, action);
  }
  return action.type === "pointer-up"
    ? commitSingleInteraction(state, interaction)
    : cancelInteraction(state, interaction, false);
}

function commitSingleInteraction(
  state: InputState,
  interaction: Exclude<InputInteraction, PinchInteraction>,
): InputReduction {
  const effects = cleanupEffects(interaction);
  const kind = previewKind(interaction);
  if (interaction.previewStarted && kind !== undefined) {
    effects.unshift({ type: "commit-preview", kind });
  } else if (interaction.phase === "lasso" && !interaction.shift) {
    effects.unshift({ type: "clear-selection" });
  }
  return { state: { ...state, interaction: undefined }, effects };
}

export function cancelInteraction(
  state: InputState,
  interaction: InputInteraction,
  consumeRemainingPointers: boolean,
): InputReduction {
  if (interaction.phase === "pinch") {
    return cancelPinch(state, interaction, consumeRemainingPointers);
  }
  const effects = cleanupEffects(interaction);
  const kind = previewKind(interaction);
  if (interaction.previewStarted && kind !== undefined) {
    effects.unshift({ type: "revert-preview", kind });
  } else if (interaction.phase === "note-scroll" || interaction.phase === "page-pan") {
    effects.unshift({ type: "revert-navigation", kind: interaction.phase });
  }
  return {
    state: {
      ...state,
      interaction: undefined,
      consumedPointerIds: consumeRemainingPointers
        ? appendIds(state.consumedPointerIds, [interaction.pointerId])
        : state.consumedPointerIds,
    },
    effects,
  };
}

function cancelPinch(
  state: InputState,
  interaction: PinchInteraction,
  consumeRemainingPointers: boolean,
): InputReduction {
  const pointerIds = interaction.pointers.map(({ pointerId }) => pointerId);
  return {
    state: {
      ...state,
      interaction: undefined,
      consumedPointerIds: consumeRemainingPointers
        ? appendIds(state.consumedPointerIds, pointerIds)
        : state.consumedPointerIds,
    },
    effects: [
      { type: "revert-pinch" },
      ...pointerIds.map<InputEffect>((pointerId) => ({ type: "release-pointer", pointerId })),
    ],
  };
}

export function handleLongPress(state: InputState, action: LongPressAction): InputReduction {
  const interaction = state.interaction;
  if (
    interaction === undefined ||
    interaction.phase === "pinch" ||
    interaction.pointerId !== action.pointerId ||
    !interaction.longPressScheduled
  ) {
    return unchangedEffects(state);
  }
  const threshold =
    interaction.phase === "element-move" ? ELEMENT_DRAG_THRESHOLD_PX : EMPTY_TOUCH_THRESHOLD_PX;
  if (distance(delta(interaction.start, interaction.current)) > threshold) {
    return unchangedEffects(state);
  }
  const effects = cleanupEffects(interaction);
  effects.push({
    type: "open-context-menu",
    source: "touch",
    position: interaction.current,
  });
  return {
    state: {
      ...state,
      interaction: undefined,
      consumedPointerIds: appendIds(state.consumedPointerIds, [interaction.pointerId]),
    },
    effects,
  };
}

export function beginPinch(
  state: InputState,
  current: Exclude<InputInteraction, PinchInteraction>,
  action: PointerDownAction,
): InputReduction {
  const first = pointerFromInteraction(current);
  const second = sample(action);
  const interaction: PinchInteraction = { phase: "pinch", pointers: [first, second] };
  const effects = cancelledTouchEffects(current);
  return {
    state: { ...state, interaction },
    effects: [
      ...effects,
      { type: "capture-pointer", pointerId: action.pointerId },
      {
        type: "begin-pinch",
        anchor: midpoint(first, second),
        pointers: [first.pointerId, second.pointerId],
      },
    ],
  };
}

function cancelledTouchEffects(
  interaction: Exclude<InputInteraction, PinchInteraction>,
): InputEffect[] {
  const effects = cancelLongPressEffects(interaction);
  const kind = previewKind(interaction);
  if (interaction.previewStarted && kind !== undefined) {
    effects.push({ type: "revert-preview", kind });
  } else if (interaction.phase === "note-scroll" || interaction.phase === "page-pan") {
    effects.push({ type: "revert-navigation", kind: interaction.phase });
  }
  return effects;
}

export function updatePinch(
  state: InputState,
  interaction: PinchInteraction,
  action: PointerMoveAction,
): InputReduction {
  const index = interaction.pointers.findIndex(({ pointerId }) => pointerId === action.pointerId);
  if (index < 0) {
    return unchangedEffects(state);
  }
  const previousDistance = pointerDistance(interaction.pointers);
  const pointers: [PointerSample, PointerSample] = [...interaction.pointers];
  pointers[index] = sample(action);
  const currentDistance = pointerDistance(pointers);
  const factor =
    previousDistance > 0 && currentDistance > 0 ? currentDistance / previousDistance : 1;
  return {
    state: { ...state, interaction: { ...interaction, pointers } },
    effects: [{ type: "update-pinch", anchor: midpoint(...pointers), factor }],
  };
}

function exitPinch(
  state: InputState,
  interaction: PinchInteraction,
  action: PointerExitAction,
): InputReduction {
  const remaining = interaction.pointers
    .map(({ pointerId }) => pointerId)
    .filter((pointerId) => pointerId !== action.pointerId);
  const terminalEffect: InputEffect =
    action.type === "pointer-up" ? { type: "finish-pinch" } : { type: "revert-pinch" };
  return {
    state: {
      ...state,
      interaction: undefined,
      consumedPointerIds: appendIds(state.consumedPointerIds, remaining),
    },
    effects: [
      terminalEffect,
      ...interaction.pointers.map<InputEffect>(({ pointerId }) => ({
        type: "release-pointer",
        pointerId,
      })),
    ],
  };
}
