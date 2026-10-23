import { useState } from "react";

import type { ToolbarAction } from "./toolbar-types";

export interface ToolbarPresenceOrder {
  readonly entering: readonly ToolbarAction[];
  readonly exiting: readonly ToolbarAction[];
}

/** Motion retains exit slots; this hook only supplies the product's stagger order. */
export function useToolbarPresenceOrder(actions: readonly ToolbarAction[]): ToolbarPresenceOrder {
  const key = actions.join("\u0000");
  const [state, setState] = useState(() => ({
    actions,
    key,
    entering: [] as readonly ToolbarAction[],
    exiting: [] as readonly ToolbarAction[],
  }));
  if (state.key !== key) {
    const next = {
      actions,
      key,
      entering: actions.filter((action) => !state.actions.includes(action)),
      exiting: state.actions.filter((action) => !actions.includes(action)).reverse(),
    };
    setState(next);
    return next;
  }
  return state;
}
