export interface CutEvent {
  readonly y: number;
  readonly at: number;
  readonly after: number;
}

interface CutChoice {
  readonly y: number;
  readonly crossings: number;
}

// Bounds one numeric preparation step; only the injected scheduler decides to hand off.
export const EXPORT_CUT_PREPARATION_CHUNK_SIZE = 256;

/** Immutable numeric index; query diagnostics do not retain document records or samples. */
export class ExportCutIndex {
  #queryVisits = 0;

  private constructor(
    private readonly events: readonly CutEvent[],
    private readonly tree: readonly number[],
    private readonly base: number,
  ) {}

  public get instrumentation(): { readonly eventCount: number; readonly queryVisits: number } {
    return { eventCount: this.events.length, queryVisits: this.#queryVisits };
  }

  public static *prepare(events: readonly CutEvent[]): Generator<void, ExportCutIndex> {
    let base = 1;
    while (base < events.length) base *= 2;
    const tree: number[] = [];
    for (let start = 0; start < base; start += EXPORT_CUT_PREPARATION_CHUNK_SIZE) {
      const end = Math.min(base, start + EXPORT_CUT_PREPARATION_CHUNK_SIZE);
      for (let index = start; index < end; index += 1) {
        tree[base + index] = index < events.length ? index : -1;
      }
      yield;
    }
    for (let end = base - 1; end > 0; end -= EXPORT_CUT_PREPARATION_CHUNK_SIZE) {
      const start = Math.max(0, end - EXPORT_CUT_PREPARATION_CHUNK_SIZE);
      for (let index = end; index > start; index -= 1) {
        tree[index] = better(events, tree[index * 2]!, tree[index * 2 + 1]!);
      }
      yield;
    }
    return new ExportCutIndex(events, tree, base);
  }

  public choose(lower: number, limit: number, start: number, clearance = 0): CutChoice {
    let first = this.#lowerBound(lower);
    if (this.events[first]?.y === start) first += 1;
    // Only the lower boundary can lose its cheaper left side when clearance moves the cut.
    const lowerChoice =
      clearance > 0 && this.events[first]?.y === lower
        ? this.#interiorCut(first++, lower, limit, clearance)
        : undefined;
    const beyond = this.#lowerBound(limit);
    const exact = beyond < this.events.length && this.events[beyond]!.y === limit;
    const limitCrossings = exact
      ? this.events[beyond]!.at
      : beyond === 0
        ? 0
        : this.events[beyond - 1]!.after;
    const best = this.#rangeMinimum(first, beyond);
    const boundary =
      best >= 0 && this.events[best]!.at < limitCrossings ? best : exact ? beyond : -1;
    const choice =
      boundary < 0
        ? { y: limit, crossings: limitCrossings }
        : this.#interiorCut(boundary, lower, limit, clearance);
    return lowerChoice && lowerChoice.crossings < choice.crossings ? lowerChoice : choice;
  }

  #interiorCut(index: number, lower: number, limit: number, clearance: number): CutChoice {
    const event = this.events[index]!;
    if (clearance <= 0) return { y: event.y, crossings: event.at };
    const previous = this.events[index - 1];
    if ((previous?.after ?? 0) <= event.after && event.y > lower) {
      const available = event.y - Math.max(lower, previous?.y ?? lower);
      return {
        y: event.y - Math.min(clearance, available / 2),
        crossings: previous?.after ?? 0,
      };
    }
    const right = Math.min(limit, this.events[index + 1]?.y ?? limit);
    const y = event.y + Math.min(clearance, Math.max(0, right - event.y) / 2);
    return { y, crossings: y === event.y ? event.at : event.after };
  }

  #lowerBound(y: number): number {
    let low = 0;
    let high = this.events.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      this.#queryVisits += 1;
      if (this.events[middle]!.y < y) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  #rangeMinimum(from: number, to: number): number {
    let left = from + this.base;
    let right = to + this.base;
    let best = -1;
    while (left < right) {
      if (left % 2 === 1) {
        this.#queryVisits += 1;
        best = better(this.events, best, this.tree[left++]!);
      }
      if (right % 2 === 1) {
        this.#queryVisits += 1;
        best = better(this.events, best, this.tree[--right]!);
      }
      left = Math.floor(left / 2);
      right = Math.floor(right / 2);
    }
    return best;
  }
}

function better(events: readonly CutEvent[], left: number, right: number): number {
  if (left < 0) return right;
  if (right < 0) return left;
  const difference = events[left]!.at - events[right]!.at;
  return difference < 0 || (difference === 0 && left > right) ? left : right;
}
