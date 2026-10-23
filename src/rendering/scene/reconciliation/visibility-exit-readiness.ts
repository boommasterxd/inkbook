import type { MountedSceneElement } from "../content/mounted-element";
import type { MutableSceneInstrumentation } from "../types";

interface IndexedExit {
  readonly id: string;
  readonly rank: number;
  position: number;
  finish: number;
  index: number;
  waiting: boolean;
}

/** An exit occupies exactly one heap slot; changes never append stale tokens. */
class ExitHeap {
  readonly #entries: IndexedExit[] = [];

  public constructor(
    private readonly waiting: boolean,
    private readonly instrumentation: MutableSceneInstrumentation,
  ) {}

  public get size(): number {
    return this.#entries.length;
  }

  public get first(): IndexedExit | undefined {
    return this.#entries[0];
  }

  public add(entry: IndexedExit): void {
    entry.waiting = this.waiting;
    entry.index = this.#entries.length;
    this.#entries.push(entry);
    this.up(entry.index);
  }

  public remove(entry: IndexedExit): void {
    const index = entry.index;
    const last = this.#entries.pop();
    entry.index = -1;
    if (last === undefined || last === entry) return;
    this.#entries[index] = last;
    last.index = index;
    this.down(this.up(index));
  }

  public clear(): void {
    this.#entries.length = 0;
  }

  private precedes(left: IndexedExit, right: IndexedExit): boolean {
    this.instrumentation.exitReadinessComparisons += 1;
    return this.waiting && left.finish !== right.finish
      ? left.finish < right.finish
      : left.rank < right.rank;
  }

  private swap(left: number, right: number): void {
    const a = this.#entries[left]!;
    const b = this.#entries[right]!;
    this.#entries[left] = b;
    this.#entries[right] = a;
    b.index = left;
    a.index = right;
  }

  private up(initial: number): number {
    let index = initial;
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (!this.precedes(this.#entries[index]!, this.#entries[parent]!)) break;
      this.swap(index, parent);
      index = parent;
    }
    return index;
  }

  private down(initial: number): void {
    let index = initial;
    while (index * 2 + 1 < this.#entries.length) {
      const left = index * 2 + 1;
      const right = left + 1;
      const child =
        right < this.#entries.length && this.precedes(this.#entries[right]!, this.#entries[left]!)
          ? right
          : left;
      if (!this.precedes(this.#entries[child]!, this.#entries[index]!)) break;
      this.swap(index, child);
      index = child;
    }
  }
}

interface ExitCursor {
  readonly exitIds: string[];
  exitIndex: number;
}

/** Indexes the existing ordered exit array without owning nodes or another fade queue. */
export class VisibilityExitReadiness {
  readonly #entries = new Map<string, IndexedExit>();
  readonly #waiting: ExitHeap;
  readonly #ready: ExitHeap;
  #scanIndex: number;
  #revision = 0;

  public constructor(
    private readonly pending: ExitCursor,
    private readonly mounted: ReadonlyMap<string, MountedSceneElement>,
    private readonly readyAt: (id: string) => number,
    private readonly instrumentation: MutableSceneInstrumentation,
  ) {
    this.#scanIndex = pending.exitIndex;
    this.#waiting = new ExitHeap(true, instrumentation);
    this.#ready = new ExitHeap(false, instrumentation);
  }

  public memoryUsage(): number {
    return this.#entries.size * 128 + (this.#waiting.size + this.#ready.size) * 8;
  }

  public get revision(): number {
    return this.#revision;
  }

  public update(id: string, finish: number): void {
    const entry = this.#entries.get(id);
    if (entry === undefined) return;
    this.instrumentation.exitReadinessVisits += 1;
    (entry.waiting ? this.#waiting : this.#ready).remove(entry);
    entry.finish = finish;
    (finish === 0 ? this.#ready : this.#waiting).add(entry);
  }

  public consume(id: string): void {
    const entry = this.#entries.get(id);
    if (entry === undefined) return;
    (entry.waiting ? this.#waiting : this.#ready).remove(entry);
    this.#entries.delete(id);
  }

  /** Initial classification and due promotions use the owning frame's shared deadline. */
  public select(frame: {
    readonly deadline: number;
    readonly now: () => number;
    readonly isExit: (id: string) => boolean;
  }): boolean {
    const head = this.pending.exitIds[this.pending.exitIndex];
    if (head === undefined) return true;
    if ((this.mounted.get(head)?.detachedPathCount ?? 0) > 0) return true;
    const scanIndex = this.#scanIndex;
    if (!this.classify(frame)) return false;
    if (scanIndex !== this.#scanIndex && frame.now() >= frame.deadline) return false;
    let promoted = false;
    while (this.#waiting.first !== undefined && this.#waiting.first.finish <= frame.now()) {
      if (promoted && frame.now() >= frame.deadline) return false;
      promoted = true;
      const entry = this.#waiting.first;
      this.#revision += 1;
      this.instrumentation.exitReadinessVisits += 1;
      this.#waiting.remove(entry);
      this.#ready.add(entry);
    }
    if (promoted && frame.now() >= frame.deadline) return false;
    const next = this.#ready.first;
    this.instrumentation.exitReadinessVisits += 1;
    if (next === undefined) return false;
    const displaced = this.#entries.get(head);
    this.pending.exitIds[this.pending.exitIndex] = next.id;
    this.pending.exitIds[next.position] = head;
    if (displaced !== undefined) displaced.position = next.position;
    next.position = this.pending.exitIndex;
    return true;
  }

  public release(): void {
    this.#entries.clear();
    this.#waiting.clear();
    this.#ready.clear();
  }

  private classify(frame: {
    readonly deadline: number;
    readonly now: () => number;
    readonly isExit: (id: string) => boolean;
  }): boolean {
    let classified = false;
    while (this.#scanIndex < this.pending.exitIds.length) {
      if (classified && frame.now() >= frame.deadline) return false;
      classified = true;
      const position = this.#scanIndex++;
      if (position < this.pending.exitIndex) continue;
      const id = this.pending.exitIds[position]!;
      this.#revision += 1;
      this.instrumentation.exitReadinessVisits += 1;
      const finish = this.mounted.has(id) && frame.isExit(id) ? this.readyAt(id) : 0;
      const entry: IndexedExit = {
        id,
        rank: position,
        position,
        finish,
        index: -1,
        waiting: false,
      };
      this.#entries.set(id, entry);
      (finish === 0 ? this.#ready : this.#waiting).add(entry);
    }
    return true;
  }
}
