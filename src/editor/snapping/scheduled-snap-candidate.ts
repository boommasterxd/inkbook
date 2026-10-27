import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import type { SpatialQueryCursor } from "../../domain/spatial/query-cursor";
import {
  candidateFromAnchor,
  anchorInSnapSquare,
  candidatePrecedes,
  findSnapCandidate,
  pageQueryBounds,
  retainCurrent,
  SNAP_RADIUS,
  HYSTERESIS_PIXELS,
  SnapCandidateScratch,
  type SnapCandidate,
  type SnapLookupInput,
  type SnapTargetReader,
  type SpatialCandidateQuery,
} from "./snap-candidate";

export type ScheduledSnapResult = SnapCandidate | null | "cancelled";

/** Resolves a complete query before publication, yielding only through its owner scheduler. */
export class ScheduledSnapCandidate {
  readonly #scheduler: WorkScheduler | undefined;
  readonly #spatial: SpatialCandidateQuery;
  readonly #targets: SnapTargetReader;
  readonly #scratch = new SnapCandidateScratch();
  #controller: AbortController | undefined;
  #pending: Promise<ScheduledSnapResult> | undefined;
  #value: SnapCandidate | null = null;
  #failed = false;
  #task: SnapCandidateTask | undefined;

  public constructor(
    spatial: SpatialCandidateQuery,
    targets: SnapTargetReader,
    scheduler?: WorkScheduler,
  ) {
    this.#spatial = spatial;
    this.#targets = targets;
    this.#scheduler = scheduler;
  }

  public get pending(): boolean {
    return this.#pending !== undefined;
  }

  public get value(): SnapCandidate | null {
    return this.#value;
  }

  public settle(): Promise<ScheduledSnapResult> {
    return this.#pending ?? Promise.resolve(this.#failed ? "cancelled" : this.#value);
  }

  public update(input: SnapLookupInput, onReady: () => void): void {
    this.cancel();
    this.#failed = false;
    const scheduler = this.#scheduler;
    if (scheduler === undefined || this.#spatial.beginQuery === undefined) {
      this.#value = findSnapCandidate(input, this.#spatial, this.#targets, this.#scratch);
      return;
    }
    const revision = this.#spatial.readRevision?.();
    const task = new SnapCandidateTask(input, this.#spatial, this.#targets);
    this.#value = null;
    if (task.run(scheduler)) {
      if (task.result !== "cancelled") this.#value = task.result;
      else this.#failed = true;
      return;
    }
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => task.cancel(), { once: true });
    this.#controller = controller;
    this.#task = task;
    this.#pending = this.#continue(task, scheduler, controller).then((result) => {
      if (this.#controller === controller) {
        if (result !== "cancelled" && revision !== this.#spatial.readRevision?.()) {
          this.update(input, onReady);
          if (!this.pending && !this.#failed) onReady();
          return this.settle();
        }
        this.#controller = undefined;
        this.#pending = undefined;
        this.#task = undefined;
        this.#failed = result === "cancelled";
        if (result !== "cancelled") {
          this.#value = result;
          onReady();
        }
      }
      return result;
    });
  }

  public cancel(): void {
    this.#task?.cancel();
    this.#task = undefined;
    this.#controller?.abort();
    this.#controller = undefined;
    this.#pending = undefined;
  }

  public memoryUsage(): number {
    return this.#task?.memoryUsage() ?? 0;
  }

  async #continue(
    task: SnapCandidateTask,
    scheduler: WorkScheduler,
    controller: AbortController,
  ): Promise<ScheduledSnapResult> {
    try {
      do {
        await scheduler.checkpoint(controller.signal, "input");
        if (controller.signal.aborted) return "cancelled";
      } while (!task.run(scheduler));
      return task.result;
    } catch {
      return "cancelled";
    } finally {
      task.cancel();
    }
  }
}

class SnapCandidateTask {
  readonly #input: SnapLookupInput;
  readonly #targets: SnapTargetReader;
  readonly #radius: number;
  readonly #bounds: ReturnType<typeof pageQueryBounds>;
  #query: SpatialQueryCursor<string> | undefined;
  #best: SnapCandidate | null = null;
  public result: ScheduledSnapResult = null;

  public constructor(
    input: SnapLookupInput,
    spatial: SpatialCandidateQuery,
    targets: SnapTargetReader,
  ) {
    this.#input = input;
    this.#targets = targets;
    this.#radius = SNAP_RADIUS[input.pointerType];
    this.#bounds = pageQueryBounds(input.pointer, this.#radius, input.zoom);
    if (!Number.isFinite(input.zoom) || input.zoom <= 0) return;
    const retained = retainCurrent(input, targets, this.#radius + HYSTERESIS_PIXELS);
    if (retained !== null) this.result = retained;
    else this.#query = spatial.beginQuery!(this.#bounds);
  }

  public run(scheduler: WorkScheduler): boolean {
    while (this.#query !== undefined) {
      if (scheduler.shouldYield()) return false;
      const step = this.#query.advance(1);
      if (step.stale) {
        this.result = "cancelled";
        this.cancel();
        return true;
      }
      for (const id of step.ids) this.#consider(id);
      if (step.done) {
        this.result = this.#best;
        this.cancel();
      }
    }
    return true;
  }

  public cancel(): void {
    this.#query?.cancel();
    this.#query = undefined;
  }

  public memoryUsage(): number {
    return this.#query?.memoryUsage() ?? 0;
  }

  #consider(id: string): void {
    const target = this.#targets.get(id, this.#bounds);
    if (target === null) return;
    for (const anchor of target.anchors) {
      if (!anchorInSnapSquare(anchor, this.#input.pointer, this.#radius, this.#input.zoom))
        continue;
      const candidate = candidateFromAnchor(
        id,
        target.rank,
        anchor,
        this.#input.pointer,
        this.#input.zoom,
      );
      if (
        candidate.distancePixels <= this.#radius &&
        (this.#best === null || candidatePrecedes(candidate, this.#best))
      )
        this.#best = candidate;
    }
  }
}
