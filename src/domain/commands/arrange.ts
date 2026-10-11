export type ArrangeAction = "bring-forward" | "send-backward" | "bring-to-front" | "send-to-back";

export interface ArrangeResult<T> {
  readonly elements: readonly T[];
  readonly changed: boolean;
}

export type SelectionPredicate<T> = (element: T) => boolean;

interface PreparedBand<T> {
  readonly elements: T[];
  readonly selection: boolean[];
  selectedCount: number;
}

function* moveAdjacentSteps<T>(
  band: PreparedBand<T>,
  forward: boolean,
  stepsPerChunk: number,
): Generator<void, T[]> {
  const { elements, selection } = band;
  const direction = forward ? -1 : 1;
  let index = forward ? elements.length - 2 : 1;
  let steps = 0;
  while (index >= 0 && index < elements.length) {
    const neighbor = index - direction;
    if (selection[index] === true && selection[neighbor] === false) {
      const element = elements[index]!;
      elements[index] = elements[neighbor]!;
      elements[neighbor] = element;
      selection[index] = false;
      selection[neighbor] = true;
    }
    index += direction;
    if (++steps % stepsPerChunk === 0) yield;
  }
  if (steps % stepsPerChunk !== 0) yield;
  return elements;
}

function* partitionSteps<T>(
  band: PreparedBand<T>,
  selectedLast: boolean,
  stepsPerChunk: number,
): Generator<void, T[]> {
  const arranged: T[] = [];
  let selectedIndex = selectedLast ? band.elements.length - band.selectedCount : 0;
  let unselectedIndex = selectedLast ? 0 : band.selectedCount;
  for (let index = 0; index < band.elements.length; index += 1) {
    const target = band.selection[index] === true ? selectedIndex++ : unselectedIndex++;
    arranged[target] = band.elements[index]!;
    if ((index + 1) % stepsPerChunk === 0) yield;
  }
  if (band.elements.length % stepsPerChunk !== 0) yield;
  return arranged;
}

/** Yields bounded logical work; the consumer's central scheduler decides when to hand off. */
export function* arrangeRenderBandSteps<T>(
  elements: readonly T[],
  selected: SelectionPredicate<T>,
  action: ArrangeAction,
  stepsPerChunk = 256,
): Generator<void, ArrangeResult<T>> {
  if (!Number.isSafeInteger(stepsPerChunk) || stepsPerChunk < 1) {
    throw new RangeError("Arrange chunk size must be a positive safe integer.");
  }
  const band: PreparedBand<T> = { elements: [], selection: [], selectedCount: 0 };
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index]!;
    const isSelected = selected(element);
    band.elements.push(element);
    band.selection.push(isSelected);
    if (isSelected) band.selectedCount += 1;
    if ((index + 1) % stepsPerChunk === 0) yield;
  }
  if (elements.length % stepsPerChunk !== 0) yield;
  const adjacent = action === "bring-forward" || action === "send-backward";
  const arranged = adjacent
    ? yield* moveAdjacentSteps(band, action === "bring-forward", stepsPerChunk)
    : yield* partitionSteps(band, action === "bring-to-front", stepsPerChunk);
  for (let index = 0; index < elements.length; index += 1) {
    if (elements[index] !== arranged[index]) return { elements: arranged, changed: true };
    if ((index + 1) % stepsPerChunk === 0) yield;
  }
  return { elements, changed: false };
}
