import type { PointV1 } from "../../schema/types";
import { PRESSURE_PREPARATION_CHECK_INTERVAL } from "./pressure-union";

/** Retain the legacy earliest-removal order while revisiting only changed neighbors. */
export function* iteratePressureCollinearPruning(points: PointV1[]): Generator<void> {
  if (points.length <= 3) return;
  for (let index = 0; index < points.length; index += 1) {
    const removable = canRemove(
      points[(index + points.length - 1) % points.length]!,
      points[index]!,
      points[(index + 1) % points.length]!,
    );
    if ((index + 1) % PRESSURE_PREPARATION_CHECK_INTERVAL === 0) yield;
    if (!removable) continue;
    yield* pruneFrom(points, index);
    return;
  }
}

function* pruneFrom(points: PointV1[], first: number): Generator<void> {
  const previous = new Uint32Array(points.length);
  const next = new Int32Array(points.length);
  const pending = new VertexQueue(points.length);
  const neighbor = (first + points.length - 1) % points.length;
  const successor = (first + 1) % points.length;
  for (let index = 0; index < points.length; index += 1) {
    previous[index] = (index + points.length - 1) % points.length;
    next[index] = (index + 1) % points.length;
    // Both neighbors change, including successor 0 when the first removal crosses the seam.
    if (index > first || index === neighbor || index === successor) pending.add(index);
    if ((index + 1) % PRESSURE_PREPARATION_CHECK_INTERVAL === 0) yield;
  }
  unlink(first, previous, next);
  let remaining = points.length - 1;
  let inspected = 0;
  while (remaining > 3 && pending.length > 0) {
    const index = pending.take();
    const before = previous[index]!;
    const after = next[index]!;
    if (canRemove(points[before]!, points[index]!, points[after]!)) {
      unlink(index, previous, next);
      remaining -= 1;
      pending.add(before);
      pending.add(after);
    }
    if (++inspected % PRESSURE_PREPARATION_CHECK_INTERVAL === 0) yield;
  }
  let retained = 0;
  for (let index = 0; index < points.length; index += 1) {
    if (next[index]! >= 0) points[retained++] = points[index]!;
    if ((index + 1) % PRESSURE_PREPARATION_CHECK_INTERVAL === 0) yield;
  }
  points.length = retained;
}

function unlink(index: number, previous: Uint32Array, next: Int32Array): void {
  const before = previous[index]!;
  const after = next[index]!;
  next[before] = after;
  previous[after] = before;
  next[index] = -1;
}

function canRemove(before: PointV1, current: PointV1, after: PointV1): boolean {
  const dx = current.x - before.x;
  const dy = current.y - before.y;
  const first = dx * (after.y - before.y);
  const second = dy * (after.x - before.x);
  if (Math.abs(first - second) > 8 * Number.EPSILON * (Math.abs(first) + Math.abs(second)))
    return false;
  return !(dx * (after.x - current.x) + dy * (after.y - current.y) < 0);
}

/** Private original-index min-heap: each live vertex has at most one queued entry. */
class VertexQueue {
  private readonly heap: Uint32Array;
  private readonly queued: Uint8Array;
  private size = 0;

  constructor(capacity: number) {
    this.heap = new Uint32Array(capacity);
    this.queued = new Uint8Array(capacity);
  }

  get length(): number {
    return this.size;
  }

  add(index: number): void {
    if (this.queued[index]) return;
    this.queued[index] = 1;
    let slot = this.size++;
    while (slot > 0) {
      const parent = (slot - 1) >> 1;
      if (this.heap[parent]! <= index) break;
      this.heap[slot] = this.heap[parent]!;
      slot = parent;
    }
    this.heap[slot] = index;
  }

  take(): number {
    const first = this.heap[0]!;
    const last = this.heap[--this.size]!;
    this.queued[first] = 0;
    if (this.size === 0) return first;
    let slot = 0;
    while (slot * 2 + 1 < this.size) {
      const left = slot * 2 + 1;
      const right = left + 1;
      const child = right < this.size && this.heap[right]! < this.heap[left]! ? right : left;
      if (this.heap[child]! >= last) break;
      this.heap[slot] = this.heap[child]!;
      slot = child;
    }
    this.heap[slot] = last;
    return first;
  }
}
