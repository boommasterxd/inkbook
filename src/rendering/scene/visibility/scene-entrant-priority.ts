import type { Bounds } from "../../../domain/geometry/primitives";
import type { MountSlice, MountYieldReason } from "../reconciliation/mount-slice";
import type { MutableSceneInstrumentation, SceneStorePort } from "../types";
import { intersects } from "./visibility-bounds";
export interface SceneVisibilityPriority {
  readonly viewport: Bounds;
  readonly direction: { readonly x: number; readonly y: number };
}

interface Candidate {
  readonly id: string;
  readonly tier: number;
  readonly distance: number;
  readonly bounds: Bounds;
}

/** Prepares only indexed visibility candidates; the heap order never changes paint order. */
export class SceneEntrantPriority {
  readonly #heap: Candidate[] = [];
  readonly #seen = new Set<string>();
  readonly #candidates = new Set<string>();
  readonly #records = new Map<string, Candidate>();
  readonly #overscan: Candidate[] = [];
  #queued: Iterator<string> = this.#candidates.values();
  #classified = false;
  #built = false;
  readonly #viewportCandidates = new Set<string>();
  #heapGeneration = 0;
  #orderingPriority: SceneVisibilityPriority | undefined;
  #insideLimits: Bounds | undefined;
  #outsideLimits = { left: -Infinity, right: Infinity, above: -Infinity, below: Infinity };
  #leadingLimits = { min: -Infinity, max: Infinity };

  public constructor(
    private readonly ids: Iterator<string, undefined>,
    private readonly store: SceneStorePort,
    private readonly mounted: { has(id: string): boolean },
    private readonly instrumentation: MutableSceneInstrumentation,
    private priority: SceneVisibilityPriority | undefined,
  ) {
    this.#orderingPriority = priority;
  }

  public get count(): number {
    return this.#heap.length;
  }

  /** Unclassified candidates cannot prove that the exact viewport is complete. */
  public get hasViewportCandidates(): boolean {
    return !this.#classified || this.#viewportCandidates.size > 0;
  }

  public get heapGeneration(): number {
    return this.#heapGeneration;
  }

  public memoryUsage(): number {
    return (
      (this.#heap.length + this.#overscan.length) * 8 +
      this.#records.size * 80 +
      (this.#seen.size + this.#candidates.size + this.#viewportCandidates.size) * 32
    );
  }

  public build(slice: MountSlice, allowViewportPublication = false): MountYieldReason | undefined {
    while (!this.#classified) {
      const blocked = slice.blockingReason();
      if (blocked !== undefined) return blocked;
      const queued = this.#queued.next();
      const next = queued.done === true ? this.ids.next() : queued;
      if (next.done === true) {
        this.#classified = true;
        this.#seen.clear();
        break;
      }
      this.instrumentation.visibilityReconcileVisits += 1;
      slice.record();
      if (this.#seen.has(next.value)) continue;
      this.#seen.add(next.value);
      if (this.mounted.has(next.value)) {
        this.#candidates.delete(next.value);
        this.#records.delete(next.value);
        continue;
      }
      const record = this.#records.get(next.value) ?? this.store.get(next.value);
      if (record === undefined) continue;
      this.#candidates.add(next.value);
      const candidate = this.candidate(record.id, record.bounds);
      if (candidate.tier === 0) this.#viewportCandidates.add(record.id);
      this.#records.set(next.value, candidate);
      if (candidate.tier === 0) this.push(candidate);
      else this.#overscan.push(candidate);
    }
    if (allowViewportPublication && this.#heap[0]?.tier === 0) return undefined;
    while (this.#overscan.length > 0) {
      const blocked = slice.blockingReason();
      if (blocked !== undefined) return blocked;
      this.push(this.#overscan.pop()!);
      slice.record();
    }
    this.#built = true;
    return undefined;
  }

  public take(): string | undefined {
    this.#heapGeneration++;
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
    const preserved =
      entered.length === 0 && exited.length === 0 && this.canPreserveOrder(priority);
    this.priority = priority;
    if (preserved) return;
    this.#heapGeneration++;
    for (const id of exited) {
      this.#candidates.delete(id);
      this.#records.delete(id);
    }
    for (const id of entered) this.#candidates.add(id);
    this.#orderingPriority = priority;
    this.#insideLimits = undefined;
    this.#outsideLimits = { left: -Infinity, right: Infinity, above: -Infinity, below: Infinity };
    this.#leadingLimits = { min: -Infinity, max: Infinity };
    this.#heap.length = 0;
    this.#overscan.length = 0;
    this.#viewportCandidates.clear();
    this.#seen.clear();
    this.#queued = this.#candidates.values();
    this.#built = false;
    this.#classified = false;
  }

  public release(id: string): void {
    this.#viewportCandidates.delete(id);
    this.#candidates.delete(id);
    this.#records.delete(id);
  }

  /** A directional translation changes all distances by one common offset. */
  private canPreserveOrder(priority: SceneVisibilityPriority | undefined): boolean {
    const previous = this.#orderingPriority;
    if (previous === undefined || priority === undefined) return previous === priority;
    const { direction } = previous;
    if (direction.x !== priority.direction.x || direction.y !== priority.direction.y) return false;
    if (
      direction.x === 0 &&
      direction.y === 0 &&
      (previous.viewport.minX + previous.viewport.maxX !==
        priority.viewport.minX + priority.viewport.maxX ||
        previous.viewport.minY + previous.viewport.maxY !==
          priority.viewport.minY + priority.viewport.maxY)
    )
      return false;
    const { viewport } = priority;
    const inside = this.#insideLimits;
    const outside = this.#outsideLimits;
    const leading = this.leadingProjection(viewport, true);
    return (
      (inside === undefined ||
        (viewport.minX <= inside.maxX &&
          viewport.maxX >= inside.minX &&
          viewport.minY <= inside.maxY &&
          viewport.maxY >= inside.minY)) &&
      outside.left < viewport.minX &&
      outside.right > viewport.maxX &&
      outside.above < viewport.minY &&
      outside.below > viewport.maxY &&
      leading >= this.#leadingLimits.min &&
      leading < this.#leadingLimits.max
    );
  }

  /** Keeps a constant-size sufficient proof that every acquired candidate retains its tier. */
  private observeTier(bounds: Bounds, tier: number): void {
    if (this.priority === undefined) return;
    if (tier === 0) {
      const previous = this.#insideLimits;
      this.#insideLimits =
        previous === undefined
          ? bounds
          : {
              minX: Math.max(previous.minX, bounds.minX),
              maxX: Math.min(previous.maxX, bounds.maxX),
              minY: Math.max(previous.minY, bounds.minY),
              maxY: Math.min(previous.maxY, bounds.maxY),
            };
      return;
    }
    const viewport = this.priority.viewport;
    const outside = this.#outsideLimits;
    const direction = this.#orderingPriority!.direction;
    if (direction.x !== 0 || direction.y !== 0) {
      const projection = this.leadingProjection(bounds);
      if (tier === 1) this.#leadingLimits.max = Math.min(this.#leadingLimits.max, projection);
      else this.#leadingLimits.min = Math.max(this.#leadingLimits.min, projection);
    }
    if (bounds.maxX < viewport.minX) outside.left = Math.max(outside.left, bounds.maxX);
    else if (bounds.minX > viewport.maxX) outside.right = Math.min(outside.right, bounds.minX);
    else if (bounds.maxY < viewport.minY) outside.above = Math.max(outside.above, bounds.maxY);
    else outside.below = Math.min(outside.below, bounds.minY);
  }

  /** Bounded protocol lookahead preserves the live heap and its viewport preparation order. */
  public *upcoming(limit: number): Generator<string> {
    if (this.#heap.length === 0 || limit <= 0) return;
    const frontier = [0];
    const generation = this.#heapGeneration;
    for (let emitted = 0; emitted < limit && frontier.length > 0; emitted += 1) {
      const index = this.takeFrontier(frontier);
      // Unclassified candidates may still contain viewport ink ahead of this overscan root.
      if (!this.#built && this.#heap[index]!.tier !== 0) return;
      yield this.#heap[index]!.id;
      if (generation !== this.#heapGeneration) return;
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
    if (this.priority === undefined) return { id, tier: 0, distance: 0, bounds };
    const { viewport, direction } = this.#orderingPriority!;
    const x = (bounds.minX + bounds.maxX - viewport.minX - viewport.maxX) / 2;
    const y = (bounds.minY + bounds.maxY - viewport.minY - viewport.maxY) / 2;
    const directional = direction.x !== 0 || direction.y !== 0;
    const tier = intersects(this.priority.viewport, bounds)
      ? 0
      : !directional ||
          this.leadingProjection(bounds) > this.leadingProjection(this.priority.viewport, true)
        ? 1
        : 2;
    this.observeTier(bounds, tier);
    return {
      id,
      bounds,
      tier,
      distance: directional ? x * direction.x + y * direction.y : x * x + y * y,
    };
  }

  /** Signed edges classify leading overscan without changing its directional distance order. */
  private leadingProjection(bounds: Bounds, viewport = false): number {
    const direction = this.#orderingPriority!.direction;
    const horizontal = Math.abs(direction.x) > Math.abs(direction.y);
    const sign = (horizontal ? direction.x : direction.y) < 0 ? -1 : 1;
    const min = (horizontal ? bounds.minX : bounds.minY) * sign;
    const max = (horizontal ? bounds.maxX : bounds.maxY) * sign;
    return viewport ? Math.max(min, max) : Math.min(min, max);
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
    this.#heapGeneration++;
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
