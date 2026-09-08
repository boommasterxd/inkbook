export type ArrangeAction = "bring-forward" | "send-backward" | "bring-to-front" | "send-to-back";

export interface ArrangeResult<T> {
  readonly elements: readonly T[];
  readonly changed: boolean;
}

export type SelectionPredicate<T> = (element: T) => boolean;

function bringForward<T>(elements: readonly T[], selection: readonly boolean[]): T[] {
  const arranged: T[] = [];
  let index = 0;

  while (index < elements.length) {
    if (selection[index] !== true) {
      arranged.push(...elements.slice(index, index + 1));
      index += 1;
      continue;
    }

    const runStart = index;
    while (selection[index] === true) index += 1;
    if (index < elements.length) arranged.push(...elements.slice(index, index + 1));
    arranged.push(...elements.slice(runStart, index));
    if (index < elements.length) index += 1;
  }

  return arranged;
}

function sendBackward<T>(elements: readonly T[], selection: readonly boolean[]): T[] {
  return bringForward([...elements].reverse(), [...selection].reverse()).reverse();
}

function stablePartition<T>(
  elements: readonly T[],
  selection: readonly boolean[],
  selectedLast: boolean,
): T[] {
  const selectedElements: T[] = [];
  const unselectedElements: T[] = [];
  for (const [index, element] of elements.entries()) {
    (selection[index] === true ? selectedElements : unselectedElements).push(element);
  }
  return selectedLast
    ? [...unselectedElements, ...selectedElements]
    : [...selectedElements, ...unselectedElements];
}

function hasOrderChanged<T>(before: readonly T[], after: readonly T[]): boolean {
  return before.some((element, index) => element !== after[index]);
}

export function arrangeRenderBand<T>(
  elements: readonly T[],
  selected: SelectionPredicate<T>,
  action: ArrangeAction,
): ArrangeResult<T> {
  const selection = elements.map(selected);
  let arranged: T[];
  switch (action) {
    case "bring-forward":
      arranged = bringForward(elements, selection);
      break;
    case "send-backward":
      arranged = sendBackward(elements, selection);
      break;
    case "bring-to-front":
      arranged = stablePartition(elements, selection, true);
      break;
    case "send-to-back":
      arranged = stablePartition(elements, selection, false);
      break;
  }

  const changed = hasOrderChanged(elements, arranged);
  return { elements: changed ? arranged : elements, changed };
}
