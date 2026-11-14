import type { TextStyleRangeV2, TextRangeStyleV2 } from "../schema/public";

export interface TextStyleSegment {
  readonly start: number;
  readonly end: number;
  readonly style: TextRangeStyleV2;
}

export function textStyleAt(
  segments: readonly TextStyleSegment[],
  position: number,
): TextRangeStyleV2 {
  let lower = 0;
  let upper = segments.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (segments[middle]!.start <= position) lower = middle + 1;
    else upper = middle;
  }
  const segment = segments[lower - 1];
  return segment && position >= segment.start && position < segment.end ? segment.style : {};
}

const PROPERTIES = [
  "fontFamily",
  "fontSize",
  "color",
  "opacity",
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "backgroundColor",
  "backgroundOpacity",
] as const;

/** Last matching range wins for each property, without rescanning all ranges per glyph. */
export function* textStyleSegmentsSteps(
  ranges: readonly TextStyleRangeV2[],
  length: number,
): Generator<void, TextStyleSegment[]> {
  const events = new Map<number, { index: number; open: boolean }[]>();
  events.set(0, []);
  events.set(length, []);
  for (const [index, range] of ranges.entries()) {
    const start = Math.max(0, Math.min(length, range.start));
    const end = Math.max(start, Math.min(length, range.end));
    if (start < end) {
      appendEvent(events, start, { index, open: true });
      appendEvent(events, end, { index, open: false });
    }
    yield;
  }
  const positions = [...events.keys()].sort((a, b) => a - b);
  const heaps = Object.fromEntries(PROPERTIES.map((key) => [key, [] as number[]])) as Record<
    (typeof PROPERTIES)[number],
    number[]
  >;
  const active = new Set<number>();
  const result: TextStyleSegment[] = [];
  for (let positionIndex = 0; positionIndex < positions.length - 1; positionIndex += 1) {
    const start = positions[positionIndex]!;
    for (const event of events.get(start)!) {
      updateActiveStyle(event, active, heaps, ranges);
      yield;
    }
    const style: TextRangeStyleV2 = {};
    for (const property of PROPERTIES) {
      const heap = heaps[property];
      while (heap.length && !active.has(heap[0]!)) heapPop(heap);
      const value = heap.length ? ranges[heap[0]!]!.style[property] : undefined;
      if (value !== undefined) Object.assign(style, { [property]: value });
    }
    result.push({ start, end: positions[positionIndex + 1]!, style });
    yield;
  }
  return result;
}

function updateActiveStyle(
  event: { index: number; open: boolean },
  active: Set<number>,
  heaps: Record<(typeof PROPERTIES)[number], number[]>,
  ranges: readonly TextStyleRangeV2[],
): void {
  if (!event.open) {
    active.delete(event.index);
    return;
  }
  active.add(event.index);
  for (const property of PROPERTIES) {
    if (ranges[event.index]!.style[property] !== undefined) heapPush(heaps[property], event.index);
  }
}

function appendEvent(
  events: Map<number, { index: number; open: boolean }[]>,
  position: number,
  event: { index: number; open: boolean },
): void {
  const atPosition = events.get(position) ?? [];
  atPosition.push(event);
  events.set(position, atPosition);
}

function heapPush(heap: number[], value: number): void {
  let index = heap.length;
  heap.push(value);
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (heap[parent]! >= value) break;
    heap[index] = heap[parent]!;
    index = parent;
  }
  heap[index] = value;
}

function heapPop(heap: number[]): void {
  const last = heap.pop();
  if (!heap.length || last === undefined) return;
  let index = 0;
  while (index * 2 + 1 < heap.length) {
    const left = index * 2 + 1;
    const right = left + 1;
    const child = right < heap.length && heap[right]! > heap[left]! ? right : left;
    if (heap[child]! <= last) break;
    heap[index] = heap[child]!;
    index = child;
  }
  heap[index] = last;
}
