import { useState } from "react";

import type { ToolbarAction, ToolbarButtonDefinition } from "./toolbar-types";

export type ToolbarButtonPresence = "entering" | "exiting" | "present";

export interface PresentToolbarButton {
  readonly definition: ToolbarButtonDefinition;
  readonly presence: ToolbarButtonPresence;
}

export function useToolbarButtonPresence(
  definitions: readonly ToolbarButtonDefinition[],
  visibleButtons: readonly ToolbarButtonDefinition[],
  visibleKey: string,
): readonly [readonly PresentToolbarButton[], (action: ToolbarAction) => void] {
  const [state, setState] = useState<{
    readonly buttons: readonly PresentToolbarButton[];
    readonly visibleKey: string;
  }>(() => ({
    buttons: visibleButtons.map((definition) => ({ definition, presence: "present" })),
    visibleKey,
  }));
  if (state.visibleKey !== visibleKey) {
    setState({
      buttons: resolvePresenceButtons(definitions, visibleButtons, state.buttons),
      visibleKey,
    });
  }
  const complete = (action: ToolbarAction): void => {
    setState((current) => ({
      ...current,
      buttons: current.buttons.flatMap((button): PresentToolbarButton[] => {
        if (button.definition.action !== action) return [button];
        if (button.presence === "exiting") return [];
        return [{ ...button, presence: "present" }];
      }),
    }));
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

export function resolvePresenceButtons(
  definitions: readonly ToolbarButtonDefinition[],
  visibleButtons: readonly ToolbarButtonDefinition[],
  previousButtons: readonly PresentToolbarButton[],
): readonly PresentToolbarButton[] {
  const visibleActions = new Set(visibleButtons.map((button) => button.action));
  const previous = new Map(previousButtons.map((button) => [button.definition.action, button]));
  return definitions.flatMap((definition): PresentToolbarButton[] => {
    const wasPresent = previous.has(definition.action);
    if (visibleActions.has(definition.action)) {
      return [{ definition, presence: wasPresent ? "present" : "entering" }];
    }
    return wasPresent ? [{ definition, presence: "exiting" }] : [];
  });
}
