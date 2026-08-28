import { useState } from "react";

import type { ToolbarAction, ToolbarButtonDefinition } from "./toolbar-types";

export type ToolbarButtonPresence = "entering" | "exiting" | "present";

export interface PresentToolbarButton {
  readonly definition: ToolbarButtonDefinition;
  readonly presence: ToolbarButtonPresence;
  readonly presenceOrder: number;
}

interface ToolbarPresenceState {
  readonly buttons: readonly PresentToolbarButton[];
  readonly completedExitActions: ReadonlySet<ToolbarAction>;
  readonly visibleKey: string;
}

export function useToolbarButtonPresence(
  definitions: readonly ToolbarButtonDefinition[],
  visibleButtons: readonly ToolbarButtonDefinition[],
  visibleKey: string,
): readonly [readonly PresentToolbarButton[], (action: ToolbarAction) => void] {
  const [state, setState] = useState<ToolbarPresenceState>(() => ({
    buttons: visibleButtons.map((definition) => ({
      definition,
      presence: "present",
      presenceOrder: 0,
    })),
    completedExitActions: new Set(),
    visibleKey,
  }));
  if (state.visibleKey !== visibleKey) {
    setState(resolveVisibilityChange(definitions, visibleButtons, visibleKey, state));
  }
  const complete = (action: ToolbarAction): void => {
    setState((current) => completePresenceAnimation(current, action));
  };
  const currentDefinitions = new Map(
    definitions.map((definition) => [definition.action, definition]),
  );
  const currentButtons = state.buttons.map((button) => ({
    ...button,
    definition: currentDefinitions.get(button.definition.action) ?? button.definition,
  }));
  return [currentButtons, complete];
}

function resolveVisibilityChange(
  definitions: readonly ToolbarButtonDefinition[],
  visibleButtons: readonly ToolbarButtonDefinition[],
  visibleKey: string,
  current: ToolbarPresenceState,
): ToolbarPresenceState {
  const buttons = resolvePresenceButtons(definitions, visibleButtons, current.buttons);
  const exitingActions = new Set(
    buttons
      .filter((button) => button.presence === "exiting")
      .map((button) => button.definition.action),
  );
  const completedExitActions = new Set(
    [...current.completedExitActions].filter((action) => exitingActions.has(action)),
  );
  return finalizeCompletedExitBatch({ buttons, completedExitActions, visibleKey });
}

function completePresenceAnimation(
  current: ToolbarPresenceState,
  action: ToolbarAction,
): ToolbarPresenceState {
  const completedButton = current.buttons.find((button) => button.definition.action === action);
  if (completedButton?.presence !== "exiting") {
    return {
      ...current,
      buttons: current.buttons.map((button) =>
        button.definition.action === action ? { ...button, presence: "present" } : button,
      ),
    };
  }
  return finalizeCompletedExitBatch({
    ...current,
    completedExitActions: new Set(current.completedExitActions).add(action),
  });
}

function finalizeCompletedExitBatch(state: ToolbarPresenceState): ToolbarPresenceState {
  const exitingButtons = state.buttons.filter((button) => button.presence === "exiting");
  if (
    exitingButtons.length === 0 ||
    !exitingButtons.every((button) => state.completedExitActions.has(button.definition.action))
  ) {
    return state;
  }
  return {
    ...state,
    buttons: state.buttons.filter((button) => button.presence !== "exiting"),
    completedExitActions: new Set(),
  };
}

export function resolvePresenceButtons(
  definitions: readonly ToolbarButtonDefinition[],
  visibleButtons: readonly ToolbarButtonDefinition[],
  previousButtons: readonly PresentToolbarButton[],
): readonly PresentToolbarButton[] {
  const visibleActions = new Set(visibleButtons.map((button) => button.action));
  const previous = new Map(previousButtons.map((button) => [button.definition.action, button]));
  const exitingCount = definitions.filter(
    (definition) => !visibleActions.has(definition.action) && previous.has(definition.action),
  ).length;
  const result: PresentToolbarButton[] = [];
  let enteringOrder = 0;
  let exitingOrder = 0;
  for (const definition of definitions) {
    const previousButton = previous.get(definition.action);
    if (visibleActions.has(definition.action)) {
      result.push({
        definition,
        presence: previousButton === undefined ? "entering" : "present",
        presenceOrder:
          previousButton === undefined ? enteringOrder++ : previousButton.presenceOrder,
      });
      continue;
    }
    if (previousButton !== undefined) {
      result.push({
        definition,
        presence: "exiting",
        presenceOrder: exitingCount - exitingOrder - 1,
      });
      exitingOrder += 1;
    }
  }
  return result;
}
