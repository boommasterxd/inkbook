import type { LaunchedBrowserWorker } from "./browser-worker-adapter";
import {
  ACTIVE_WORKER_SLICE_MS,
  IDLE_WORKER_SLICE_MS,
  WORKER_ADMISSION_BYTES,
  WORKER_PROTOCOL_VERSION,
  StaleWorkerResultError,
  WorkerCrashedError,
  WorkerDisposedError,
  WorkerQueueExhaustedError,
  WorkerRequestCancelledError,
} from "./protocol";
import { handleWorkerResponse } from "./response";
import { readSchedulerLimits } from "./scheduler-config";
import type {
  ByteWorkerSchedulerOptions,
  PendingTask,
  TaskInput,
  StructuredWorkerSubmission,
  StructuredWorkerWork,
} from "./scheduler-types";
import { assertWorkerWorkBounds } from "./work-profiles";
import {
  assertWorkerRevision,
  createPendingTask,
  toWorkerProcessingError,
} from "./task";

export type {
  ByteWorkerSchedulerOptions,
  StructuredWorkerSubmission,
  StructuredWorkerWork,
  WorkerSliceScheduler,
} from "./scheduler-types";

export class ByteWorkerScheduler {
  private readonly options: ByteWorkerSchedulerOptions;
  private readonly maxOutstandingRequests: number;
  private readonly maxOutstandingBytes: number;
  private readonly maxReservedBytes: number;
  private readonly queue: PendingTask[] = [];
  private active: PendingTask | undefined;
  private launched: LaunchedBrowserWorker | undefined;
  private fallbackOnly = false;
  private launchAttempted = false;
  private disposed = false;
  private nextId = 1;
  private outstandingBytes = 0;
  private outstandingReservedBytes = 0;
  private cancelScheduledSlice: (() => void) | undefined;

  public constructor(options: ByteWorkerSchedulerOptions) {
    const limits = readSchedulerLimits(options);
    this.options = options;
    this.maxOutstandingRequests = limits.maxOutstandingRequests;
    this.maxOutstandingBytes = limits.maxOutstandingBytes;
    this.maxReservedBytes = limits.maxReservedBytes;
  }

  public submitStructured<TResult>(
    work: StructuredWorkerWork<TResult>,
  ): StructuredWorkerSubmission<TResult> {
    this.assertOpen();
    assertWorkerRevision(work.revision);
    assertWorkerWorkBounds(work.kind, work.inputBytes, work);
    this.assertCapacity(
      work.inputBytes,
      work.inputBytes + work.maxOutputBytes + work.scratchBytes,
    );
    return this.admit({
      workKind: work.kind,
      revision: work.revision,
      priority: work.priority,
      mode: work.mode,
      maxOutputBytes: work.maxOutputBytes,
      scratchBytes: work.scratchBytes,
      workerFirst:
        work.workerFirst === true || work.inputBytes >= WORKER_ADMISSION_BYTES,
      structuredPayload: work.payload,
      normalizeStructuredResult: work.normalizeResult,
      fallbackProcessorFactory: work.createFallbackProcessor,
      inputBytes: work.inputBytes,
    }) as StructuredWorkerSubmission<TResult>;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelScheduledSlice?.();
    this.cancelScheduledSlice = undefined;
    this.releaseWorker();
    const error = new WorkerDisposedError();
    if (this.active !== undefined) this.settle(this.active, error);
    for (const task of this.queue.splice(0)) this.settle(task, error);
    this.active = undefined;
  }

  private admit(input: TaskInput): StructuredWorkerSubmission<unknown> {
    const reservedBytes =
      input.inputBytes + input.maxOutputBytes + input.scratchBytes;
    const inputBytes = input.inputBytes;
    this.assertCapacity(inputBytes, reservedBytes);
    const task = createPendingTask(input, this.nextId++);
    this.outstandingBytes += task.byteLength;
    this.outstandingReservedBytes += task.reservedBytes;
    this.enqueue(task);
    this.drain();
    return { result: task.promise, cancel: (): void => this.cancel(task) };
  }

  private assertOpen(): void {
    if (this.disposed) throw new WorkerDisposedError();
  }

  private assertCapacity(inputBytes: number, reservedBytes: number): void {
    this.assertOpen();
    const count = this.queue.length + (this.active === undefined ? 0 : 1);
    if (
      count >= this.maxOutstandingRequests ||
      this.outstandingBytes + inputBytes > this.maxOutstandingBytes ||
      this.outstandingReservedBytes + reservedBytes > this.maxReservedBytes
    ) {
      throw new WorkerQueueExhaustedError();
    }
  }

  private enqueue(task: PendingTask): void {
    if (task.priority === "current") this.queue.unshift(task);
    else this.queue.push(task);
  }

  private drain(): void {
    if (this.disposed || this.active !== undefined) return;
    const task = this.queue.shift();
    if (task === undefined) return;
    this.active = task;
    if (!task.workerFirst) {
      this.startFallbackSlice(task);
      return;
    }
    if (!this.launchAttempted) this.tryLaunch();
    if (this.fallbackOnly) this.startFallbackSlice(task);
    else {
      task.sentToWorker = true;
      this.sendToWorker(task);
    }
  }

  private tryLaunch(): void {
    this.launchAttempted = true;
    try {
      this.launched = this.options.launchWorker();
    } catch {
      this.launched = undefined;
    }
    if (this.launched === undefined) {
      this.fallbackOnly = true;
      return;
    }
    this.launched.worker.addEventListener("message", this.onMessage);
    this.launched.worker.addEventListener("error", this.onWorkerFailure);
    this.launched.worker.addEventListener("messageerror", this.onWorkerFailure);
  }

  private sendToWorker(task: PendingTask): void {
    try {
      const request = {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        kind: "process-structured",
        requestId: task.id,
        workKind: task.workKind,
        revision: task.revision,
        byteLength: task.byteLength,
        maxOutputBytes: task.maxOutputBytes,
        scratchBytes: task.scratchBytes,
        payload: task.structuredPayload,
      } as const;
      this.launched?.worker.postMessage(request);
    } catch {
      this.handleWorkerFailure();
    }
  }

  private readonly onMessage = (event: MessageEvent<unknown>): void => {
    const task = this.active;
    if (task === undefined) return;
    const outcome = handleWorkerResponse(event.data, task);
    if (outcome.kind === "error") this.finish(task, outcome.error);
    else if (outcome.kind === "complete") this.publish(task, outcome.output);
  };

  private readonly onWorkerFailure = (): void => this.handleWorkerFailure();

  private handleWorkerFailure(): void {
    if (this.fallbackOnly) return;
    this.fallbackOnly = true;
    this.releaseWorker();
    const task = this.active;
    if (task !== undefined) this.finish(task, new WorkerCrashedError());
  }

  private startFallbackSlice(task: PendingTask): void {
    try {
      task.fallbackProcessor ??= task.fallbackProcessorFactory();
    } catch (error: unknown) {
      this.finish(task, toWorkerProcessingError(error));
      return;
    }
    try {
      this.cancelScheduledSlice = this.options.slices.schedule(
        task.mode,
        () => {
          this.cancelScheduledSlice = undefined;
          this.runFallbackSlice(task);
        },
      );
    } catch (error: unknown) {
      this.finish(task, toWorkerProcessingError(error));
    }
  }

  private runFallbackSlice(task: PendingTask): void {
    if (task !== this.active || this.disposed) return;
    if (task.cancelled) {
      this.finish(task, new WorkerRequestCancelledError());
      return;
    }
    const budget =
      task.mode === "active" ? ACTIVE_WORKER_SLICE_MS : IDLE_WORKER_SLICE_MS;
    const deadline = this.options.clock.now() + budget;
    try {
      const complete = this.runFallbackWork(task, deadline);
      if (complete) this.completeFallback(task);
      else this.startFallbackSlice(task);
    } catch (error: unknown) {
      this.finish(task, toWorkerProcessingError(error));
    }
  }

  private runFallbackWork(task: PendingTask, deadline: number): boolean {
    const processor = task.fallbackProcessor;
    if (processor === undefined) {
      throw new Error("Fallback processor is unavailable.");
    }
    while (this.options.clock.now() < deadline) {
      if (processor.processNext()) return true;
    }
    return false;
  }

  private completeFallback(task: PendingTask): void {
    try {
      const output = task.fallbackProcessor?.complete();
      this.publish(task, task.normalizeStructuredResult(output));
    } catch (error: unknown) {
      this.finish(task, toWorkerProcessingError(error));
    }
  }

  private publish(task: PendingTask, output: unknown): void {
    if (!this.options.isCurrent(task.revision)) {
      this.finish(task, new StaleWorkerResultError());
      return;
    }
    this.finish(task, undefined, output);
  }

  private cancel(task: PendingTask): void {
    if (task.cancelled || this.disposed) return;
    task.cancelled = true;
    const queuedIndex = this.queue.indexOf(task);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.settle(task, new WorkerRequestCancelledError());
      return;
    }
    if (task === this.active && task.sentToWorker) {
      try {
        this.launched?.worker.postMessage({
          protocolVersion: WORKER_PROTOCOL_VERSION,
          kind: "cancel",
          requestId: task.id,
        });
      } catch {
        this.handleWorkerFailure();
      }
      return;
    }
    if (task === this.active) {
      this.cancelScheduledSlice?.();
      this.cancelScheduledSlice = undefined;
      this.finish(task, new WorkerRequestCancelledError());
    }
  }

  private finish(task: PendingTask, error?: Error, output?: unknown): void {
    if (task !== this.active) return;
    this.active = undefined;
    this.settle(task, error, output);
    this.drain();
  }

  private settle(task: PendingTask, error?: Error, output?: unknown): void {
    this.outstandingBytes -= task.byteLength;
    this.outstandingReservedBytes -= task.reservedBytes;
    task.fallbackProcessor?.dispose?.();
    if (error !== undefined) task.reject(error);
    else task.resolve(output);
  }

  private releaseWorker(): void {
    const launched = this.launched;
    if (launched === undefined) return;
    launched.worker.removeEventListener("message", this.onMessage);
    launched.worker.removeEventListener("error", this.onWorkerFailure);
    launched.worker.removeEventListener("messageerror", this.onWorkerFailure);
    this.launched = undefined;
    try {
      launched.dispose();
    } catch {
      // Terminal cleanup is best-effort after listeners and ownership are released.
    }
  }
}
