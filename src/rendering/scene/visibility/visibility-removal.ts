import type { Bounds } from "../../../domain/geometry/primitives";
import type { VisibilityResult } from "./visibility-types";

interface RemovalSnapshot {
  readonly source: VisibilityResult;
  readonly bounds: Bounds;
  readonly content: string[];
  readonly highlight: string[];
  readonly exited: string[];
  band: "content" | "highlight";
  index: number;
}

/** Reuses only committed membership; unfinished copies never mutate published arrays. */
export class VisibilityRemovalReuse {
  #generation = 0;
  #proof: VisibilityResult | undefined;
  #pending: RemovalSnapshot | undefined;
  #ranksDirty = false;

  public constructor(
    private readonly source: {
      readonly current: () => VisibilityResult;
      readonly bounds: () => Bounds | undefined;
      readonly ready: () => boolean;
      readonly contains: (id: string) => boolean;
      readonly updateRank: (id: string, rank: number) => void;
    },
  ) {}

  public get ranksDirty(): boolean {
    return this.#ranksDirty;
  }

  public invalidate(): void {
    this.#generation += 1;
    this.#proof = undefined;
    this.#pending = undefined;
  }

  public ranksFresh(): void {
    this.#ranksDirty = false;
  }

  public beginCommit(visibility: VisibilityResult): number | undefined {
    return this.source.ready() && this.matches(visibility) ? this.#generation : undefined;
  }

  public updateRank(id: string, rank: number): void {
    this.source.updateRank(id, rank);
  }

  public finishCommit(
    visibility: VisibilityResult,
    generation: number | undefined,
    ranksFresh = false,
  ): void {
    if (generation === this.#generation && this.source.ready() && this.matches(visibility)) {
      this.#proof = visibility;
      if (ranksFresh) this.ranksFresh();
    }
  }

  public begin(): boolean {
    const bounds = this.source.bounds();
    if (this.#proof === undefined || bounds === undefined || !this.source.ready()) return false;
    if (!this.matches(this.#proof)) return false;
    this.#pending = {
      source: this.#proof,
      bounds,
      content: [],
      highlight: [],
      exited: [],
      band: "highlight",
      index: 0,
    };
    this.#proof = undefined;
    this.#generation += 1;
    this.#ranksDirty = true;
    return true;
  }

  public advance(
    bounds: Bounds,
    deadline: number,
    now: () => number,
    allowed: boolean,
  ): RemovalSnapshot | "pending" | undefined {
    const pending = this.#pending;
    if (pending === undefined) return undefined;
    if (!allowed || !equalBounds(bounds, pending.bounds) || !this.matches(pending.source)) {
      this.invalidate();
      return undefined;
    }
    while (now() < deadline) {
      const band = pending.source[pending.band];
      if (pending.index === band.count) {
        if (pending.band === "content") {
          this.#pending = undefined;
          if (pending.exited.length === 0) this.#proof = pending.source;
          return pending;
        }
        pending.band = "content";
        pending.index = 0;
        continue;
      }
      const id = band.ids[pending.index++]!;
      if (this.source.contains(id)) pending[pending.band].push(id);
      else pending.exited.push(id);
    }
    return "pending";
  }

  public memoryUsage(): number {
    const pending = this.#pending;
    return pending === undefined
      ? 0
      : (pending.content.length + pending.highlight.length + pending.exited.length) * 8;
  }

  private matches(visibility: VisibilityResult): boolean {
    const current = this.source.current();
    return (
      current.content.ids === visibility.content.ids &&
      current.content.count === visibility.content.count &&
      current.highlight.ids === visibility.highlight.ids &&
      current.highlight.count === visibility.highlight.count
    );
  }
}

function equalBounds(left: Bounds, right: Bounds): boolean {
  return (
    left.minX === right.minX &&
    left.minY === right.minY &&
    left.maxX === right.maxX &&
    left.maxY === right.maxY
  );
}
