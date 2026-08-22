import type { ToolbarAction } from "./toolbar-types";

export function resolveToolbarFocusRecovery(
  previousActions: readonly ToolbarAction[],
  visibleActions: readonly ToolbarAction[],
  focusedAction: ToolbarAction,
): ToolbarAction | null {
  if (visibleActions.length === 0) return null;
  if (visibleActions.includes(focusedAction)) return focusedAction;
  const previousIndex = previousActions.indexOf(focusedAction);
  if (previousIndex < 0) return visibleActions[0] ?? null;
  let nearest = visibleActions[0] ?? null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const action of visibleActions) {
    const candidateIndex = previousActions.indexOf(action);
    if (candidateIndex < 0) continue;
    const distance = Math.abs(candidateIndex - previousIndex);
    if (distance < nearestDistance) {
      nearest = action;
      nearestDistance = distance;
    }
  }
  return nearest;
}

export function nextToolbarIndex(key: string, index: number, length: number): number | null {
  if (length === 0) return null;
  if (key === "ArrowRight" || key === "ArrowDown") return (index + 1) % length;
  if (key === "ArrowLeft" || key === "ArrowUp") return (index - 1 + length) % length;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  return null;
}
