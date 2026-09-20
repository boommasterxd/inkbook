import { assertFinitePoint, type Bounds } from "../../domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../domain/schema/public";
import { createSweptCapsuleCheck, type SweptCapsuleCheck } from "./eraser-intersection";

const ERASER_FADE_MS = 300;
const WORK_UNITS_PER_UPDATE = 12_288;
const QUERY_BATCH_WORK_UNITS = 128;
const UPDATE_CHECKPOINT_WORK_UNITS = 1_024;
const MAX_FINALIZATION_CHECKPOINT_WORK_UNITS = 256;
const FINALIZATION_WORK_UNITS_PER_MS = 16;
const FINALIZATION_SCHEDULING_RESERVE_MS = 0.25;
export const MAX_RETAINED_ERASER_SWEEPS = 512;

export function screenPixelsToPageUnits(screenPixels: number, zoom: number): number {
  if (!Number.isFinite(screenPixels) || screenPixels < 0) {
    throw new RangeError("Screen pixels must be finite and non-negative.");
  }
  if (!Number.isFinite(zoom) || zoom <= 0) {
    throw new RangeError("Zoom must be finite and positive.");
  }
  return screenPixels / zoom;
}

interface PendingSweep {
  readonly end: PointV1;
  readonly start: PointV1;
}

interface ActiveSweep extends PendingSweep {
  ids: readonly string[];
  readonly cursor: EraserQueryCursor;
  queryDone: boolean;
  check: SweptCapsuleCheck | null;
  index: number;
}

export interface EraserQueryCursor {
  advance(maxWorkUnits: number): {
    readonly ids: readonly string[];
    readonly workUnits: number;
    readonly done: boolean;
    readonly stale: boolean;
  };
  cancel(): void;
}

export interface EraserQueryPort {
  beginQuery(bounds: Bounds): EraserQueryCursor;
  getElement(id: string): InkElementV1 | undefined;
}

export interface EraserFeedbackPort {
  setCandidateFade(ids: ReadonlySet<string>, durationMs: number): void;
  addCandidateFade?(ids: readonly string[], durationMs: number): void;
  clearCandidateFade(ids: ReadonlySet<string>): void;
}

export interface EraserSliceScheduler {
  isCancelled(): boolean;
  shouldYield(): boolean;
  yieldControl(): Promise<void>;
}

export type EraserUpdateResult = "accepted" | "cancelled";

export class EraserSweep {
  readonly #candidates = new Set<string>();
  readonly #feedback: EraserFeedbackPort;
  readonly #pendingSweeps: PendingSweep[] = [];
  readonly #query: EraserQueryPort;
  readonly #radius: number;
  readonly #sliceBudgetMs: () => number;
  readonly #updateAdded: string[] = [];
  #activeSweep: ActiveSweep | null = null;
  #previous: PointV1;
  #state: "active" | "cancelled" | "finished" | "finishing" = "active";

  public constructor(
    start: PointV1,
    radius: number,
    query: EraserQueryPort,
    feedback: EraserFeedbackPort,
    sliceBudgetMs: () => number = () => 8,
  ) {
    if (!Number.isFinite(radius) || radius <= 0)
      throw new RangeError("Eraser radius must be positive.");
    this.#previous = finitePoint(start);
    this.#radius = radius;
    this.#query = query;
    this.#feedback = feedback;
    this.#sliceBudgetMs = sliceBudgetMs;
    this.#pendingSweeps.push({ end: this.#previous, start: this.#previous });
    this.#processUpdatePending();
    this.#publishUpdateAdded();
  }

  public get candidateCount(): number {
    return this.#candidates.size;
  }

  public get candidateIds(): ReadonlySet<string> {
    return new Set(this.#candidates);
  }

  public get retainedCandidateIdCount(): number {
    return this.#activeSweep?.ids.length ?? 0;
  }

  public get retainedSweepCount(): number {
    return this.#pendingSweeps.length + Number(this.#activeSweep !== null);
  }

  public update(pointValue: PointV1): EraserUpdateResult {
    return this.updateBatch([pointValue]);
  }

  public updateBatch(points: readonly PointV1[]): EraserUpdateResult {
    if (this.enqueueBatch(points) === "cancelled") return "cancelled";
    this.#processUpdatePending();
    this.#publishUpdateAdded();
    return this.#isCancelled() ? "cancelled" : "accepted";
  }

  public enqueueBatch(points: readonly PointV1[]): EraserUpdateResult {
    if (this.#state === "cancelled") return "cancelled";
    if (this.#state !== "active") throw new Error("A finalized eraser sweep cannot be updated.");
    for (const pointValue of points) {
      assertFinitePoint(pointValue);
      if (pointValue.x === this.#previous.x && pointValue.y === this.#previous.y) continue;
      const point = { x: pointValue.x, y: pointValue.y };
      if (this.retainedSweepCount >= MAX_RETAINED_ERASER_SWEEPS) {
        this.revert();
        return "cancelled";
      }
      this.#pendingSweeps.push({ end: point, start: this.#previous });
      this.#previous = point;
    }
    return "accepted";
  }

  public async commit(
    remove: (ids: ReadonlySet<string>) => boolean | Promise<boolean>,
    scheduler: EraserSliceScheduler,
  ): Promise<boolean> {
    if (this.#state === "cancelled") return false;
    if (this.#state !== "active") throw new Error("An eraser sweep can only be committed once.");
    this.#state = "finishing";
    const added: string[] = [];
    while (this.retainedSweepCount > 0) {
      const sliceBudgetMs = Math.max(0, this.#sliceBudgetMs() - FINALIZATION_SCHEDULING_RESERVE_MS);
      const deadline = performance.now() + sliceBudgetMs;
      const workUnits = finalizationWorkUnits(sliceBudgetMs);
      let remaining = WORK_UNITS_PER_UPDATE;
      do {
        if (scheduler.isCancelled() || this.#isCancelled()) return this.#cancelFinalization();
        const checkpoint = Math.min(remaining, workUnits);
        this.#processPending(checkpoint, added);
        remaining -= checkpoint;
        if (this.retainedSweepCount === 0) break;
      } while (remaining > 0 && !scheduler.shouldYield() && performance.now() < deadline);
      this.#publishAdded(added);
      added.length = 0;
      if (this.retainedSweepCount > 0) await scheduler.yieldControl();
    }
    this.#publishAdded(added);
    if (scheduler.isCancelled() || this.#isCancelled()) return this.#cancelFinalization();
    try {
      return this.#candidates.size > 0 && (await remove(this.#candidates));
    } finally {
      this.#feedback.clearCandidateFade(this.#candidates);
      this.#candidates.clear();
      this.#state = "finished";
    }
  }

  public revert(): void {
    if (this.#state === "finished" || this.#state === "cancelled") return;
    this.#feedback.clearCandidateFade(this.#candidates);
    this.#candidates.clear();
    this.#activeSweep?.cursor.cancel();
    this.#activeSweep = null;
    this.#pendingSweeps.length = 0;
    this.#updateAdded.length = 0;
    this.#state = "cancelled";
  }

  #isCancelled(): boolean {
    return this.#state === "cancelled";
  }

  #cancelFinalization(): false {
    this.revert();
    return false;
  }

  #processUpdatePending(): void {
    const deadline = performance.now() + this.#sliceBudgetMs();
    const added = this.#updateAdded;
    for (
      let remaining = WORK_UNITS_PER_UPDATE;
      remaining > 0 && this.retainedSweepCount > 0;
      remaining -= UPDATE_CHECKPOINT_WORK_UNITS
    ) {
      this.#processPending(Math.min(remaining, UPDATE_CHECKPOINT_WORK_UNITS), added);
      if (performance.now() >= deadline) break;
    }
  }

  #publishUpdateAdded(): void {
    const added = this.#updateAdded;
    this.#publishAdded(added);
    added.length = 0;
  }

  #processPending(workUnits: number, added: string[]): void {
    let remaining = workUnits;
    while (remaining > 0) {
      if (this.#activeSweep === null) remaining -= 1;
      const sweep = this.#activeSweep ?? this.#activateNextSweep();
      if (sweep === null) break;
      const before = remaining;
      remaining = this.#advanceActiveSweep(sweep, remaining, added);
      if (sweep.queryDone && sweep.index >= sweep.ids.length) {
        sweep.cursor.cancel();
        this.#activeSweep = null;
      }
      if (remaining === before && this.#activeSweep !== null) break;
    }
  }

  #publishAdded(added: readonly string[]): void {
    if (added.length === 0) return;
    if (this.#feedback.addCandidateFade !== undefined)
      this.#feedback.addCandidateFade(added, ERASER_FADE_MS);
    else this.#feedback.setCandidateFade(this.#candidates, ERASER_FADE_MS);
  }

  #activateNextSweep(): ActiveSweep | null {
    const pending = this.#pendingSweeps.shift();
    if (pending === undefined) return null;
    const cursor = this.#query.beginQuery(sweepBounds(pending.start, pending.end, this.#radius));
    this.#activeSweep = { ...pending, check: null, cursor, ids: [], index: 0, queryDone: false };
    return this.#activeSweep;
  }

  #advanceActiveSweep(sweep: ActiveSweep, workUnits: number, added: string[]): number {
    let remaining = workUnits;
    while (remaining > 0) {
      if (sweep.index >= sweep.ids.length) {
        if (sweep.queryDone) break;
        remaining = this.#queryNextBatch(sweep, remaining, added);
        if (this.#isCancelled()) return 0;
        if (sweep.ids.length === 0) continue;
        if (remaining <= 0) break;
      }
      remaining = this.#advanceCandidate(sweep, remaining, added);
    }
    return remaining;
  }

  #advanceCandidate(sweep: ActiveSweep, remaining: number, added: string[]): number {
    const id = sweep.ids[sweep.index]!;
    if (sweep.check === null) remaining -= 1;
    if (this.#candidates.has(id)) {
      sweep.index += 1;
      sweep.check = null;
      return remaining;
    }
    const check = this.#ensureCheck(sweep, id);
    if (check === null) {
      sweep.index += 1;
      return remaining;
    }
    if (remaining <= 0) return 0;
    const progress = check.advance(remaining);
    if (progress.result === null) return 0;
    sweep.check = null;
    sweep.index += 1;
    if (progress.result) {
      this.#candidates.add(id);
      added.push(id);
    }
    return remaining - progress.workUnits;
  }

  #queryNextBatch(sweep: ActiveSweep, remaining: number, added: string[]): number {
    const progress = sweep.cursor.advance(Math.min(remaining, QUERY_BATCH_WORK_UNITS));
    if (progress.stale) {
      this.revert();
      added.length = 0;
      return 0;
    }
    sweep.ids = progress.ids;
    sweep.index = 0;
    sweep.queryDone = progress.done;
    return remaining - progress.workUnits;
  }

  #ensureCheck(sweep: ActiveSweep, id: string): SweptCapsuleCheck | null {
    if (sweep.check !== null) return sweep.check;
    const element = this.#query.getElement(id);
    if (element === undefined) return null;
    sweep.check = createSweptCapsuleCheck(sweep.start, sweep.end, this.#radius, element);
    return sweep.check;
  }
}

function finalizationWorkUnits(sliceBudgetMs: number): number {
  if (!Number.isFinite(sliceBudgetMs) || sliceBudgetMs <= 0) return 1;
  return Math.max(
    1,
    Math.min(
      MAX_FINALIZATION_CHECKPOINT_WORK_UNITS,
      Math.floor(sliceBudgetMs * FINALIZATION_WORK_UNITS_PER_MS),
    ),
  );
}

function sweepBounds(start: PointV1, end: PointV1, radius: number): Bounds {
  return {
    minX: Math.min(start.x, end.x) - radius,
    minY: Math.min(start.y, end.y) - radius,
    maxX: Math.max(start.x, end.x) + radius,
    maxY: Math.max(start.y, end.y) + radius,
  };
}

function finitePoint(point: PointV1): PointV1 {
  assertFinitePoint(point, "Eraser points must be finite.");
  return { x: point.x, y: point.y };
}
