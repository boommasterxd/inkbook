import type {
  InputInteraction,
  InputReduction,
  InputState,
  PenModeChangeAction,
} from "./input-types";
import {
  appendIds,
  point,
  sample,
  unchangedEffects,
  withInteraction,
} from "./input-reducer-operations";
import { isValidPointerSample } from "./pointer-validation";

type PenGesture = Extract<InputInteraction, { phase: "tool-gesture" | "eraser-gesture" }>;

export function handlePenModeChange(
  state: InputState,
  action: PenModeChangeAction,
): InputReduction {
  const interaction = state.interaction;
  if (!ownsPenGesture(interaction, action) || state.activeTool === "select") {
    return unchangedEffects(state);
  }
  if (interaction.phase === "tool-gesture" && action.penRole !== "normal") {
    return startPenEraser(state, interaction, action);
  }
  if (
    interaction.phase === "eraser-gesture" &&
    interaction.temporaryEraser &&
    interaction.previousTool !== "eraser" &&
    interaction.penRole !== "normal" &&
    action.penRole === "normal" &&
    !action.controlOrMeta
  ) {
    return {
      state: {
        ...state,
        interaction: undefined,
        consumedPointerIds: appendIds(state.consumedPointerIds, [action.pointerId]),
      },
      effects: [
        { type: "commit-preview", kind: "eraser-gesture" },
        { type: "restore-temporary-tool", tool: interaction.previousTool },
      ],
    };
  }
  return unchangedEffects(state);
}

function ownsPenGesture(
  interaction: InputInteraction | undefined,
  action: PenModeChangeAction,
): interaction is PenGesture {
  return (
    (interaction?.phase === "tool-gesture" || interaction?.phase === "eraser-gesture") &&
    interaction.pointerType === "pen" &&
    action.pointerType === "pen" &&
    interaction.pointerId === action.pointerId &&
    isValidPointerSample(action)
  );
}

function startPenEraser(
  state: InputState,
  interaction: PenGesture,
  action: PenModeChangeAction,
): InputReduction {
  return withInteraction(
    state,
    {
      ...interaction,
      phase: "eraser-gesture",
      penRole: action.penRole,
      controlOrMeta: action.controlOrMeta,
      shift: action.shift,
      start: point(action),
      current: point(action),
      temporaryEraser: true,
      tool: "eraser",
    },
    [
      { type: "revert-preview", kind: "tool-gesture" },
      { type: "activate-temporary-eraser", previousTool: interaction.previousTool },
      {
        type: "begin-preview",
        kind: "eraser-gesture",
        tool: "eraser",
        pointer: sample(action),
        additive: false,
      },
    ],
  );
}
