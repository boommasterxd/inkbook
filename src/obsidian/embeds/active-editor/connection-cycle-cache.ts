import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { ElementStore } from "../../../domain/store/public";
import { prepareConnectionCycleTargets } from "../../../domain/store/connection-cycle-targets";

const SET_HEADER_BYTES = 128;
const SET_ENTRY_BYTES = 48;
const TRAVERSAL_HEADER_BYTES = 256;
const TRAVERSAL_ENTRY_BYTES = 64;

/** One gesture source owns a complete reverse reachability set; partial sets never authorize snaps. */
export class ConnectionCycleCache {
  #sourceId: string | undefined;
  #forbidden = new Set<string>();
  #generation = 0;
  #ready = false;
  #released = false;
  #memoryPressure = false;
  #notifiedBytes = 0;
  readonly #pendingReservations = new Map<number, number>();
  #pending: Promise<boolean> | undefined;
  #controller: AbortController | undefined;
  #unsubscribeSignal: (() => void) | undefined;
  readonly #unsubscribe: () => void;

  public constructor(
    private readonly store: ElementStore,
    private readonly onMemoryUsageChanged: () => void = () => undefined,
  ) {
    this.#unsubscribe = store.subscribe((delta) => {
      if (
        delta.changes.some(
          (change) =>
            change.domains.includes("connection") ||
            change.before === null ||
            change.after === null,
        )
      ) {
        this.clear();
      }
    });
  }

  public canConnect(sourceId: string, targetId: string): boolean {
    return (
      !this.#released &&
      this.#ready &&
      this.#sourceId === sourceId &&
      !this.#forbidden.has(targetId)
    );
  }

  public prepare(
    sourceId: string,
    scheduler: WorkScheduler,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (this.#released || this.#memoryPressure || signal?.aborted) return Promise.resolve(false);
    if (this.#sourceId === sourceId) {
      if (this.#ready) return Promise.resolve(true);
      if (this.#pending !== undefined) return this.#pending;
    }
    this.clear();
    this.#sourceId = sourceId;
    const controller = new AbortController();
    this.#controller = controller;
    const generation = this.#generation;
    const abort = () => {
      if (this.#generation === generation) this.clear();
    };
    signal?.addEventListener("abort", abort, { once: true });
    this.#unsubscribeSignal = () => signal?.removeEventListener("abort", abort);
    // IDs remain Store-owned. Reserve Set entries and the traversal stack until
    // cancelled work actually settles; aborted suspensions still retain locals.
    this.#pendingReservations.set(
      generation,
      TRAVERSAL_HEADER_BYTES + (this.store.size + 1) * TRAVERSAL_ENTRY_BYTES,
    );
    this.#notifyMemoryUsage();
    const pending = this.#collect(sourceId, scheduler, controller.signal, generation).finally(
      () => {
        this.#pendingReservations.delete(generation);
        if (!this.#ready && this.#generation === generation) this.clear();
        if (this.#pending === pending) this.#pending = undefined;
        this.#notifyMemoryUsage();
      },
    );
    this.#pending = pending;
    return pending;
  }

  async #collect(
    sourceId: string,
    scheduler: WorkScheduler,
    signal: AbortSignal,
    generation: number,
  ): Promise<boolean> {
    try {
      const forbidden = await prepareConnectionCycleTargets(
        sourceId,
        (id) => this.store.beginDependents(id),
        {
          isCancelled: () => signal.aborted || this.#generation !== generation,
          shouldYield: () => scheduler.shouldYield(),
          yieldControl: () => scheduler.checkpoint(signal, "frame") ?? Promise.resolve(),
        },
      );
      if (forbidden === null || signal.aborted || this.#generation !== generation) return false;
      this.#forbidden = forbidden;
      this.#ready = true;
      this.#pendingReservations.delete(generation);
      this.#notifyMemoryUsage();
      return this.#ready && this.#generation === generation;
    } catch (error) {
      if (signal.aborted) return false;
      throw error;
    }
  }

  public clear(): void {
    this.#unsubscribeSignal?.();
    this.#unsubscribeSignal = undefined;
    this.#controller?.abort();
    this.#controller = undefined;
    this.#generation += 1;
    this.#sourceId = undefined;
    this.#forbidden.clear();
    this.#ready = false;
    this.#pending = undefined;
    this.#notifyMemoryUsage();
  }

  public memoryUsage(): number {
    let bytes = this.#ready ? SET_HEADER_BYTES + this.#forbidden.size * SET_ENTRY_BYTES : 0;
    for (const reservation of this.#pendingReservations.values()) bytes += reservation;
    return bytes;
  }

  public setMemoryPressure(active: boolean): void {
    this.#memoryPressure = active;
    if (active) this.clear();
  }

  #notifyMemoryUsage(): void {
    const bytes = this.memoryUsage();
    if (bytes === this.#notifiedBytes) return;
    this.#notifiedBytes = bytes;
    this.onMemoryUsageChanged();
  }

  public release(): void {
    this.#released = true;
    this.clear();
    this.#unsubscribe();
  }
}
