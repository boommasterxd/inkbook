export interface BottomHeapEntry<Id> {
  readonly bottom: number;
  readonly id: Id;
  readonly recordVersion: number;
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
    siftDown(heap, index);
  }
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

function siftDown<Id>(heap: BottomHeapEntry<Id>[], start: number): void {
  const entry = heap[start];
  if (entry === undefined) return;
  let index = start;
  while (true) {
    const leftIndex = index * 2 + 1;
    if (leftIndex >= heap.length) break;
    const rightIndex = leftIndex + 1;
    const left = heap[leftIndex]!;
    const right = heap[rightIndex];
    const childIndex = right !== undefined && right.bottom > left.bottom ? rightIndex : leftIndex;
    const child = heap[childIndex]!;
    if (child.bottom <= entry.bottom) break;
    heap[index] = child;
    index = childIndex;
  }
  heap[index] = entry;
}
