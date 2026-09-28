import { SchedulerDisposedError } from "./work-scheduler";
import type { FrameCancellation, WorkPriority, WorkScheduler } from "./work-scheduler";

/** Host timing is injected so the same admission policy runs in a window or worker. */
export interface FrameSchedulerHost {
  /** Workers resume on a new host task because they have no paint frame to protect. */
  readonly continuationMode?: "frame" | "task";
  readonly now: () => number;
  readonly budgetMs: () => number;
  readonly frameIntervalMs: () => number;
  readonly requestFrame: (callback: (timestamp: number) => void) => number;
  readonly cancelFrame: (handle: number) => void;
  readonly setTimer: (callback: () => void, delayMs: number) => number;
  readonly clearTimer: (handle: number) => void;
  readonly isHidden: () => boolean;
  readonly fallbackDelayMs?: number;
  readonly dispose?: () => void;
}

interface FrameJob {
  readonly handle: number;
  readonly priority: WorkPriority;
  readonly earliestEpoch: number;
  readonly run: (timestamp: number) => void;
  readonly onCancel: ((reason: Error) => void) | undefined;
  readonly signal: FrameCancellation | undefined;
  readonly onAbort: () => void;
  readonly resumesWork: boolean;
}

const DEFAULT_FALLBACK_DELAY_MS = 50;
const FRAME_TIMESTAMP_EPSILON_MS = 0.001;

/** Queues all work against one deadline per host frame, including async continuations. */
export class SharedFrameScheduler implements WorkScheduler {
  readonly #host: FrameSchedulerHost;
  readonly #fallbackDelayMs: number;
  readonly #jobs = new Map<number, FrameJob>();
  readonly #queues = {
    input: new Map<number, FrameJob>(),
    frame: new Map<number, FrameJob>(),
    background: new Map<number, FrameJob>(),
  };
  #nextHandle = 0;
  #epoch = 0;
  #epochStart: number | undefined;
  #lastNativeFrameTimestamp: number | undefined;
  #frameHandle: number | undefined;
  #timerHandle: number | undefined;
  #resumeHandle: number | undefined;
  #taskBoundaryHandle: number | undefined;
  #generation = 0;
  #processing = false;
  #taskOpen = false;
  #admittedThisEpoch = false;
  #disposed = false;

  public constructor(host: FrameSchedulerHost) {
    this.#host = host;
    this.#fallbackDelayMs = positiveFinite(
      host.fallbackDelayMs ?? DEFAULT_FALLBACK_DELAY_MS,
      "fallbackDelayMs",
    );
    positiveFinite(host.budgetMs(), "budgetMs");
    positiveFinite(host.frameIntervalMs(), "frameIntervalMs");
  }

  public now(): number {
    return this.#host.now();
  }

  public budgetMs(): number {
    return positiveFinite(this.#host.budgetMs(), "budgetMs");
  }

  public deadline(): number {
    return this.#ensureEpoch(this.now()) + this.budgetMs();
  }

  public shouldYield(): boolean {
    if (this.#disposed) return true;
    const now = this.now();
    const expired = now >= this.#ensureEpoch(now) + this.budgetMs();
    if (expired && !this.#processing) this.#admittedThisEpoch = true;
    return expired;
  }

  /** A callback queued during a frame is never admitted in that same frame. */
  public requestFrame(
    callback: (timestamp: number) => void,
    priority: WorkPriority = "frame",
  ): number {
    return this.#enqueue(callback, undefined, undefined, false, priority);
  }

  public cancelFrame(handle: number): void {
    const job = this.#jobs.get(handle);
    if (job !== undefined) this.#cancelJob(job, new Error("Frame work cancelled."));
  }

  /** No promise is created while the current shared epoch still has budget. */
  public checkpoint(signal?: FrameCancellation): Promise<void> | undefined {
    if (signal?.aborted) return Promise.reject(cancelReason(signal));
    if (this.#disposed) return Promise.reject(disposedError());
    return this.shouldYield() ? this.#waitForFrame(signal, "background") : undefined;
  }

  /** An intentional paint boundary always waits for a later host frame. */
  public nextFrame(
    signal?: FrameCancellation,
    priority: WorkPriority = "background",
  ): Promise<void> {
    return this.#waitForFrame(signal, priority);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelPending();
    if (this.#taskBoundaryHandle !== undefined) this.#host.clearTimer(this.#taskBoundaryHandle);
    for (const job of this.#jobs.values()) this.#cancelJob(job, disposedError());
    this.#epochStart = undefined;
    this.#host.dispose?.();
  }

  #waitForFrame(signal: FrameCancellation | undefined, priority: WorkPriority): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#enqueue(() => resolve(), reject, signal, true, priority);
    });
  }

  #enqueue(
    run: (timestamp: number) => void,
    onCancel: ((reason: Error) => void) | undefined,
    signal: FrameCancellation | undefined,
    resumesWork: boolean,
    priority: WorkPriority,
  ): number {
    if (this.#disposed || signal?.aborted) {
      onCancel?.(this.#disposed ? disposedError() : cancelReason(signal));
      return 0;
    }
    const handle = ++this.#nextHandle;
    const job: FrameJob = {
      handle,
      priority,
      earliestEpoch: this.#epoch + 1,
      run,
      onCancel,
      signal,
      onAbort: () => this.#cancelJob(job, cancelReason(signal)),
      resumesWork,
    };
    this.#jobs.set(handle, job);
    this.#queues[priority].set(handle, job);
    signal?.addEventListener("abort", job.onAbort, { once: true });
    if (signal?.aborted) this.#cancelJob(job, cancelReason(signal));
    else this.#arm();
    return handle;
  }

  #cancelJob(job: FrameJob, reason: Error): void {
    if (!this.#jobs.delete(job.handle)) return;
    this.#queues[job.priority].delete(job.handle);
    job.signal?.removeEventListener("abort", job.onAbort);
    job.onCancel?.(reason);
    if (this.#jobs.size === 0) this.#cancelPending();
  }

  #arm(): void {
    if (this.#disposed || this.#jobs.size === 0 || this.#processing) return;
    if (this.#resumeHandle !== undefined) return;
    if (this.#frameHandle !== undefined || this.#timerHandle !== undefined) return;
    const generation = ++this.#generation;
    if (this.#host.continuationMode === "task") {
      this.#timerHandle = this.#host.setTimer(
        () => this.#beginFrame(generation, this.now(), false),
        0,
      );
      return;
    }
    this.#timerHandle = this.#host.setTimer(
      () => this.#beginFrame(generation, this.now(), false),
      this.#fallbackDelayMs,
    );
    if (!this.#host.isHidden()) {
      this.#frameHandle = this.#host.requestFrame((timestamp) =>
        this.#beginFrame(generation, timestamp, true),
      );
    }
  }

  #beginFrame(generation: number, timestamp: number, nativeFrame: boolean): void {
    if (this.#disposed || generation !== this.#generation) return;
    const entryTime = nativeFrame ? this.now() : timestamp;
    this.#cancelPending();
    this.#epoch += 1;
    const previous = this.#epochStart;
    const nativeAdvance =
      nativeFrame &&
      this.#lastNativeFrameTimestamp !== undefined &&
      timestamp > this.#lastNativeFrameTimestamp;
    if (
      this.#host.continuationMode === "task" ||
      nativeAdvance ||
      previous === undefined ||
      (timestamp >= previous &&
        timestamp - previous + FRAME_TIMESTAMP_EPSILON_MS >=
          positiveFinite(this.#host.frameIntervalMs(), "frameIntervalMs"))
    ) {
      // The native timestamp identifies the frame, but the shared work slice starts
      // when this scheduler first gets control after other host frame callbacks.
      this.#epochStart = entryTime;
      this.#admittedThisEpoch = false;
    } else if (entryTime >= previous + this.budgetMs()) {
      // A synchronous caller may have spent the epoch without a final checkpoint.
      this.#admittedThisEpoch = true;
    }
    if (nativeFrame) this.#lastNativeFrameTimestamp = timestamp;
    this.#markTaskOpen();
    this.#processReady(timestamp);
  }

  #processReady(timestamp: number): void {
    if (this.#disposed) return;
    this.#processing = true;
    try {
      while (this.#jobs.size > 0) {
        const job = this.#nextReadyJob();
        if (job === undefined) break;
        if (this.#admittedThisEpoch && this.shouldYield()) break;
        this.#jobs.delete(job.handle);
        this.#queues[job.priority].delete(job.handle);
        job.signal?.removeEventListener("abort", job.onAbort);
        this.#admittedThisEpoch = true;
        job.run(timestamp);
        if (job.resumesWork) {
          if (this.#jobs.size > 0) this.#queueResume(timestamp);
          break;
        }
      }
    } finally {
      this.#processing = false;
      this.#arm();
    }
  }

  #queueResume(timestamp: number): void {
    this.#resumeHandle = this.#host.setTimer(() => {
      this.#resumeHandle = undefined;
      this.#processReady(timestamp);
    }, 0);
  }

  #nextReadyJob(): FrameJob | undefined {
    for (const priority of ["input", "frame", "background"] as const) {
      const job = this.#queues[priority].values().next().value;
      if (job !== undefined && job.earliestEpoch <= this.#epoch) return job;
    }
    return undefined;
  }

  #cancelPending(): void {
    this.#generation += 1;
    if (this.#frameHandle !== undefined) this.#host.cancelFrame(this.#frameHandle);
    if (this.#timerHandle !== undefined) this.#host.clearTimer(this.#timerHandle);
    if (this.#resumeHandle !== undefined) this.#host.clearTimer(this.#resumeHandle);
    this.#frameHandle = undefined;
    this.#timerHandle = undefined;
    this.#resumeHandle = undefined;
  }

  #ensureEpoch(now: number): number {
    const previous = this.#epochStart;
    if (
      previous === undefined ||
      (!this.#taskOpen &&
        !this.#processing &&
        this.#jobs.size === 0 &&
        this.#frameHandle === undefined &&
        this.#timerHandle === undefined &&
        (this.#host.continuationMode === "task" ||
          now - previous >= positiveFinite(this.#host.frameIntervalMs(), "frameIntervalMs")))
    ) {
      this.#epochStart = now;
      this.#epoch += 1;
      this.#admittedThisEpoch = false;
      this.#lastNativeFrameTimestamp = undefined;
    }
    this.#markTaskOpen();
    return this.#epochStart ?? now;
  }

  #markTaskOpen(): void {
    if (this.#taskOpen) return;
    this.#taskOpen = true;
    this.#taskBoundaryHandle = this.#host.setTimer(() => {
      this.#taskBoundaryHandle = undefined;
      this.#taskOpen = false;
    }, 0);
  }
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`);
  }
  return value;
}

function cancelReason(signal: FrameCancellation | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("Frame work aborted.");
}

function disposedError(): SchedulerDisposedError {
  return new SchedulerDisposedError();
}
