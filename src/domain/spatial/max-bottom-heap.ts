export interface BottomHeapEntry<Id> {
  readonly bottom: number;
  readonly id: Id;
  readonly recordVersion: number;
}

interface CurrentBottomEntry {
  readonly maxY: number;
  readonly overflow: boolean;
  readonly recordVersion: number;
}

export function bottomHeapEntry<Id>(
  entry: CurrentBottomEntry & { readonly id: Id },
): BottomHeapEntry<Id> {
  return { bottom: entry.maxY, id: entry.id, recordVersion: entry.recordVersion };
}

function isBottomEntryStale<Id>(
  heapEntry: BottomHeapEntry<Id>,
  current: CurrentBottomEntry | undefined,
): boolean {
  return (
    current === undefined ||
    current.overflow ||
    current.recordVersion !== heapEntry.recordVersion ||
    current.maxY !== heapEntry.bottom
  );
}

function isBottomHeadStale<Id>(
  heap: readonly BottomHeapEntry<Id>[],
  entries: ReadonlyMap<Id, CurrentBottomEntry>,
): boolean {
  const head = heap[0];
  return head !== undefined && isBottomEntryStale(head, entries.get(head.id));
}

export function scanMaximumBottom<Id>(
  heap: BottomHeapEntry<Id>[],
  batches: readonly BottomHeapEntry<Id>[][],
  entries: ReadonlyMap<Id, CurrentBottomEntry>,
  maxStalePops: number,
  overflowMaximum: number | undefined,
): {
  readonly cleanupPending: boolean;
  readonly maximum: number | undefined;
  readonly stalePops: number;
} {
  let stalePops = 0;
  let maximum: number | undefined;
  let cleanupPending = false;
  for (let heapIndex = 0; heapIndex <= batches.length; heapIndex += 1) {
    const currentHeap = heapIndex === 0 ? heap : batches[heapIndex - 1]!;
    while (stalePops < maxStalePops && isBottomHeadStale(currentHeap, entries)) {
      popMaximumBottom(currentHeap);
      stalePops += 1;
    }
    const head = currentHeap[0];
    cleanupPending ||= head !== undefined && isBottomEntryStale(head, entries.get(head.id));
    if (head !== undefined) maximum = Math.max(maximum ?? -Infinity, head.bottom);
  }
  return {
    cleanupPending,
    maximum:
      maximum === undefined
        ? overflowMaximum
        : overflowMaximum === undefined
          ? maximum
          : Math.max(maximum, overflowMaximum),
    stalePops,
  };
}

export function shouldRebuildExtent(
  heapEntries: number,
  gridEntries: number,
  totalEntries: number,
): boolean {
  return heapEntries - gridEntries > totalEntries;
}

export function pushBottom<Id>(heap: BottomHeapEntry<Id>[], entry: BottomHeapEntry<Id>): void {
  let index = heap.length;
  heap.push(entry);

  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2);
    const parent = heap[parentIndex];
    if (parent === undefined || parent.bottom >= entry.bottom) break;
    heap[index] = parent;
    index = parentIndex;
  }

  heap[index] = entry;
}

export function heapifyBottom<Id>(heap: BottomHeapEntry<Id>[]): void {
  for (let index = Math.floor(heap.length / 2) - 1; index >= 0; index -= 1) {
    heapifyBottomAt(heap, index);
  }
}

export function heapifyBottomAt<Id>(heap: BottomHeapEntry<Id>[], index: number): number {
  return siftDown(heap, index);
}

export function popMaximumBottom<Id>(heap: BottomHeapEntry<Id>[]): BottomHeapEntry<Id> | undefined {
  const maximum = heap[0];
  const tail = heap.pop();
  if (maximum === undefined || tail === undefined || heap.length === 0) return maximum;

  let index = 0;
  while (true) {
    const leftIndex = index * 2 + 1;
    if (leftIndex >= heap.length) break;

    const rightIndex = leftIndex + 1;
    const left = heap[leftIndex];
    const right = heap[rightIndex];
    if (left === undefined) break;

    const childIndex = right !== undefined && right.bottom > left.bottom ? rightIndex : leftIndex;
    const child = heap[childIndex];
    if (child === undefined || child.bottom <= tail.bottom) break;
    heap[index] = child;
    index = childIndex;
  }

  heap[index] = tail;
  return maximum;
}

function siftDown<Id>(heap: BottomHeapEntry<Id>[], start: number): number {
  const entry = heap[start];
  if (entry === undefined) return 0;
  let index = start;
  let comparisons = 0;
  while (true) {
    const leftIndex = index * 2 + 1;
    if (leftIndex >= heap.length) break;
    const rightIndex = leftIndex + 1;
    const left = heap[leftIndex]!;
    const right = heap[rightIndex];
    if (right !== undefined) comparisons += 1;
    const childIndex = right !== undefined && right.bottom > left.bottom ? rightIndex : leftIndex;
    const child = heap[childIndex]!;
    comparisons += 1;
    if (child.bottom <= entry.bottom) break;
    heap[index] = child;
    index = childIndex;
  }
  heap[index] = entry;
  return comparisons;
}
