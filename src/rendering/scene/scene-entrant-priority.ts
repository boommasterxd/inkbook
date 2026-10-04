import type { Bounds } from "../../domain/geometry/primitives";
import type { MountSlice, MountYieldReason } from "./mount-slice";
import type { MutableSceneInstrumentation, SceneStorePort } from "./types";
import { intersects } from "./visibility-bounds";
export interface SceneVisibilityPriority {
  readonly viewport: Bounds;
  readonly direction: { readonly x: number; readonly y: number };
}

interface Candidate {
  readonly id: string;
  readonly tier: number;
  readonly distance: number;
}

/** Prepares only indexed visibility candidates; the heap order never changes paint order. */
export class SceneEntrantPriority {
  readonly #heap: Candidate[] = [];
  readonly #seen = new Set<string>();
  readonly #candidates = new Set<string>();
  #queued: Iterator<string> = this.#candidates.values();
  #built = false;

  public constructor(
    private readonly ids: Iterator<string, undefined>,
    private readonly store: SceneStorePort,
    private readonly mounted: { has(id: string): boolean },
    private readonly instrumentation: MutableSceneInstrumentation,
    private priority: SceneVisibilityPriority | undefined,
  ) {}

  public get count(): number {
    return this.#heap.length;
  }

  public memoryUsage(): number {
    return this.#heap.length * 40 + (this.#seen.size + this.#candidates.size) * 32;
  }

  public build(slice: MountSlice): MountYieldReason | undefined {
    while (!this.#built) {
      const blocked = slice.blockingReason();
      if (blocked !== undefined) return blocked;
      const queued = this.#queued.next();
      const next = queued.done === true ? this.ids.next() : queued;
      if (next.done === true) {
        this.#built = true;
        this.#seen.clear();
        break;
      }
      this.instrumentation.visibilityReconcileVisits += 1;
      slice.record();
      if (this.#seen.has(next.value)) continue;
      this.#seen.add(next.value);
      if (this.mounted.has(next.value)) {
        this.#candidates.delete(next.value);
        continue;
      }
      const record = this.store.get(next.value);
      if (record === undefined) continue;
      this.#candidates.add(next.value);
      this.push(this.candidate(record.id, record.bounds));
    }
    return undefined;
  }

  public take(): string | undefined {
    const first = this.#heap[0];
    const last = this.#heap.pop();
    if (first === undefined || last === undefined) return undefined;
    if (this.#heap.length > 0) {
      this.#heap[0] = last;
      this.siftDown();
    }
    return first.id;
  }

  /** Keeps one flat queue; current membership deltas release exits instead of retaining history. */
  public retarget(
    entered: readonly string[],
    exited: readonly string[],
    priority: SceneVisibilityPriority | undefined,
  ): void {
    for (const id of exited) this.#candidates.delete(id);
    for (const id of entered) this.#candidates.add(id);
    this.priority = priority;
    this.#heap.length = 0;
    this.#seen.clear();
    this.#queued = this.#candidates.values();
    this.#built = false;
  }

  public release(id: string): void {
    this.#candidates.delete(id);
  }

  /** Bounded protocol lookahead preserves the live heap and its viewport preparation order. */
  public *upcoming(limit: number): Generator<string> {
    if (this.#heap.length === 0 || limit <= 0) return;
    const frontier = [0];
    for (let emitted = 0; emitted < limit && frontier.length > 0; emitted += 1) {
      const index = this.takeFrontier(frontier);
      yield this.#heap[index]!.id;
      const left = index * 2 + 1;
      if (left < this.#heap.length) this.pushFrontier(frontier, left);
      if (left + 1 < this.#heap.length) this.pushFrontier(frontier, left + 1);
    }
  }

  private pushFrontier(frontier: number[], index: number): void {
    let cursor = frontier.length;
    frontier.push(index);
    while (cursor > 0) {
      const parent = Math.floor((cursor - 1) / 2);
      if (!this.earlier(this.#heap[index]!, this.#heap[frontier[parent]!]!)) break;
      frontier[cursor] = frontier[parent]!;
      cursor = parent;
    }
    frontier[cursor] = index;
  }

  private takeFrontier(frontier: number[]): number {
    const first = frontier[0]!;
    const last = frontier.pop()!;
    if (frontier.length === 0) return first;
    let cursor = 0;
    while (cursor * 2 + 1 < frontier.length) {
      const left = cursor * 2 + 1;
      const right = left + 1;
      const child =
        right < frontier.length &&
        this.earlier(this.#heap[frontier[right]!]!, this.#heap[frontier[left]!]!)
          ? right
          : left;
      if (!this.earlier(this.#heap[frontier[child]!]!, this.#heap[last]!)) break;
      frontier[cursor] = frontier[child]!;
      cursor = child;
    }
    frontier[cursor] = last;
    return first;
  }

  private candidate(id: string, bounds: Bounds): Candidate {
    if (this.priority === undefined) return { id, tier: 0, distance: 0 };
    const { viewport, direction } = this.priority;
    const x = (bounds.minX + bounds.maxX - viewport.minX - viewport.maxX) / 2;
    const y = (bounds.minY + bounds.maxY - viewport.minY - viewport.maxY) / 2;
    const directional = direction.x !== 0 || direction.y !== 0;
    return {
      id,
      tier: intersects(viewport, bounds) ? 0 : 1,
      distance: directional ? x * direction.x + y * direction.y : x * x + y * y,
    };
  }

  private earlier(left: Candidate, right: Candidate): boolean {
    return (
      left.tier < right.tier ||
      (left.tier === right.tier &&
        (left.distance < right.distance ||
          (left.distance === right.distance && left.id.localeCompare(right.id) < 0)))
    );
  }

  private push(candidate: Candidate): void {
    let index = this.#heap.length;
    this.#heap.push(candidate);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.earlier(candidate, this.#heap[parent]!)) break;
      this.#heap[index] = this.#heap[parent]!;
      index = parent;
    }
    this.#heap[index] = candidate;
  }

  private siftDown(): void {
    let index = 0;
    const candidate = this.#heap[0]!;
    while (index * 2 + 1 < this.#heap.length) {
      const left = index * 2 + 1;
      const right = left + 1;
      const child =
        right < this.#heap.length && this.earlier(this.#heap[right]!, this.#heap[left]!)
          ? right
          : left;
      if (!this.earlier(this.#heap[child]!, candidate)) break;
      this.#heap[index] = this.#heap[child]!;
      index = child;
    }
    this.#heap[index] = candidate;
  }
}
