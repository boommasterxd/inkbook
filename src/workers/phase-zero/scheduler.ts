import type { LaunchedBrowserWorker } from "./browser-worker-adapter";
import {
  PHASE_ZERO_ACTIVE_SLICE_MS,
  PHASE_ZERO_CHUNK_BYTES,
  PHASE_ZERO_IDLE_SLICE_MS,
  PHASE_ZERO_MAX_REQUEST_BYTES,
  PHASE_ZERO_PROTOCOL_VERSION,
  StaleWorkerResultError,
  WorkerCrashedError,
  WorkerDisposedError,
  WorkerQueueExhaustedError,
  WorkerRequestCancelledError,
  type PhaseZeroPriority,
  type PhaseZeroRequest,
  type PhaseZeroRevision,
  type PhaseZeroSliceMode,
  type PhaseZeroWorkerResponse,
} from "./protocol";

const DEFAULT_MAX_OUTSTANDING_REQUESTS = 8;
const DEFAULT_MAX_OUTSTANDING_BYTES = 4_194_304;
const TRANSFORM_MASK = 0xff;

interface PhaseZeroClock {
  now(): number;
}

export interface PhaseZeroSliceScheduler {
  schedule(mode: PhaseZeroSliceMode, callback: () => void): () => void;
}

export interface PhaseZeroSchedulerOptions {
  readonly launchWorker: () => LaunchedBrowserWorker | undefined;
  readonly clock: PhaseZeroClock;
  readonly slices: PhaseZeroSliceScheduler;
  readonly isCurrent: (revision: PhaseZeroRevision) => boolean;
  readonly maxOutstandingRequests?: number;
  readonly maxOutstandingBytes?: number;
}

export interface PhaseZeroSubmission {
  readonly result: Promise<Uint8Array<ArrayBuffer>>;
  cancel(): void;
}

interface PendingTask {
  readonly id: number;
  readonly revision: PhaseZeroRevision;
  readonly priority: PhaseZeroPriority;
  readonly mode: PhaseZeroSliceMode;
  readonly input: Uint8Array<ArrayBuffer>;
  readonly byteLength: number;
  readonly promise: Promise<Uint8Array<ArrayBuffer>>;
  readonly resolve: (result: Uint8Array<ArrayBuffer>) => void;
  readonly reject: (reason: Error) => void;
  cancelled: boolean;
  output?: Uint8Array<ArrayBuffer>;
  offset: number;
}

export class PhaseZeroWorkerScheduler {
  private readonly options: PhaseZeroSchedulerOptions;
  private readonly maxOutstandingRequests: number;
  private readonly maxOutstandingBytes: number;
  private readonly queue: PendingTask[] = [];
  private active: PendingTask | undefined;
  private launched: LaunchedBrowserWorker | undefined;
  private fallbackOnly = false;
  private launchAttempted = false;
  private disposed = false;
  private nextId = 1;
  private outstandingBytes = 0;
  private cancelScheduledSlice: (() => void) | undefined;

  public constructor(options: PhaseZeroSchedulerOptions) {
    this.options = options;
    this.maxOutstandingRequests =
      options.maxOutstandingRequests ?? DEFAULT_MAX_OUTSTANDING_REQUESTS;
    this.maxOutstandingBytes =
      options.maxOutstandingBytes ?? DEFAULT_MAX_OUTSTANDING_BYTES;
  }

  public submit(
    input: Uint8Array<ArrayBuffer>,
    revision: PhaseZeroRevision,
    priority: PhaseZeroPriority,
    mode: PhaseZeroSliceMode,
  ): PhaseZeroSubmission {
    this.assertAdmission(input);
    const task = this.createTask(input, revision, priority, mode);
    this.outstandingBytes += input.byteLength;
    this.enqueue(task);
    this.drain();
    return { result: task.promise, cancel: (): void => this.cancel(task) };
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

  private assertAdmission(input: Uint8Array<ArrayBuffer>): void {
    if (this.disposed) throw new WorkerDisposedError();
    if (
      input.byteLength > PHASE_ZERO_MAX_REQUEST_BYTES ||
      input.byteOffset !== 0 ||
      input.byteLength !== input.buffer.byteLength
    ) {
      throw new RangeError(
        "The staging buffer violates worker request bounds.",
      );
    }
    const count = this.queue.length + (this.active === undefined ? 0 : 1);
    if (
      count >= this.maxOutstandingRequests ||
      this.outstandingBytes + input.byteLength > this.maxOutstandingBytes
    ) {
      throw new WorkerQueueExhaustedError();
    }
  }

  private createTask(
    input: Uint8Array<ArrayBuffer>,
    revision: PhaseZeroRevision,
    priority: PhaseZeroPriority,
    mode: PhaseZeroSliceMode,
  ): PendingTask {
    let resolveResult: PendingTask["resolve"] = () => undefined;
    let rejectResult: PendingTask["reject"] = () => undefined;
    const promise = new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const task: PendingTask = {
      id: this.nextId++,
      revision,
      priority,
      mode,
      input,
      byteLength: input.byteLength,
      resolve: resolveResult,
      reject: rejectResult,
      cancelled: false,
      offset: 0,
      promise,
    };
    return task;
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
    if (!this.launchAttempted) this.tryLaunch();
    if (this.fallbackOnly) this.startFallbackSlice(task);
    else this.sendToWorker(task);
  }

  private tryLaunch(): void {
    this.launchAttempted = true;
    this.launched = this.options.launchWorker();
    if (this.launched === undefined) {
      this.fallbackOnly = true;
      return;
    }
    this.launched.worker.addEventListener("message", this.onMessage);
    this.launched.worker.addEventListener("error", this.onWorkerFailure);
    this.launched.worker.addEventListener("messageerror", this.onWorkerFailure);
  }

  private sendToWorker(task: PendingTask): void {
    const request: PhaseZeroRequest = {
      protocolVersion: PHASE_ZERO_PROTOCOL_VERSION,
      kind: "transform",
      requestId: task.id,
      revision: task.revision,
      byteLength: task.byteLength,
      chunkBytes: PHASE_ZERO_CHUNK_BYTES,
      payload: task.input.buffer,
    };
    try {
      this.launched?.worker.postMessage(request, [request.payload]);
    } catch {
      this.handleWorkerFailure();
    }
  }

  private readonly onMessage = (event: MessageEvent<unknown>): void => {
    const task = this.active;
    if (task === undefined) return;
    const response = parseResponse(event.data, task.id);
    if (response === undefined) return;
    if (response.kind === "cancelled") {
      this.finish(task, new WorkerRequestCancelledError());
      return;
    }
    if (response.kind === "error") {
      this.finish(
        task,
        new Error(response.message ?? "Worker request failed."),
      );
      return;
    }
    if (!sameRevision(response.revision, task.revision)) {
      this.finish(task, new StaleWorkerResultError());
      return;
    }
    if (response.byteLength !== task.byteLength) {
      this.finish(
        task,
        new Error("Worker response length does not match request."),
      );
      return;
    }
    this.publish(task, new Uint8Array(response.payload));
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
    task.output ??= new Uint8Array(task.input.byteLength);
    this.cancelScheduledSlice = this.options.slices.schedule(task.mode, () => {
      this.cancelScheduledSlice = undefined;
      this.runFallbackSlice(task);
    });
  }

  private runFallbackSlice(task: PendingTask): void {
    if (task !== this.active || this.disposed) return;
    if (task.cancelled) {
      this.finish(task, new WorkerRequestCancelledError());
      return;
    }
    const output = task.output;
    if (output === undefined) return;
    const budget =
      task.mode === "active"
        ? PHASE_ZERO_ACTIVE_SLICE_MS
        : PHASE_ZERO_IDLE_SLICE_MS;
    const deadline = this.options.clock.now() + budget;
    while (
      task.offset < task.input.length &&
      this.options.clock.now() < deadline
    ) {
      output[task.offset] = (task.input[task.offset] ?? 0) ^ TRANSFORM_MASK;
      task.offset += 1;
    }
    if (task.offset === task.input.length) this.publish(task, output);
    else this.startFallbackSlice(task);
  }

  private publish(task: PendingTask, output: Uint8Array<ArrayBuffer>): void {
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
    if (task === this.active && !this.fallbackOnly) {
      this.launched?.worker.postMessage({
        protocolVersion: PHASE_ZERO_PROTOCOL_VERSION,
        kind: "cancel",
        requestId: task.id,
      });
    }
  }

  private finish(
    task: PendingTask,
    error?: Error,
    output?: Uint8Array<ArrayBuffer>,
  ): void {
    if (task !== this.active) return;
    this.active = undefined;
    this.settle(task, error, output);
    this.drain();
  }

  private settle(
    task: PendingTask,
    error?: Error,
    output?: Uint8Array<ArrayBuffer>,
  ): void {
    this.outstandingBytes -= task.byteLength;
    if (error !== undefined) task.reject(error);
    else if (output !== undefined) task.resolve(output);
  }

  private releaseWorker(): void {
    const launched = this.launched;
    if (launched === undefined) return;
    launched.worker.removeEventListener("message", this.onMessage);
    launched.worker.removeEventListener("error", this.onWorkerFailure);
    launched.worker.removeEventListener("messageerror", this.onWorkerFailure);
    launched.dispose();
    this.launched = undefined;
  }
}

function parseResponse(
  value: unknown,
  requestId: number,
): PhaseZeroWorkerResponse | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<PhaseZeroWorkerResponse>;
  if (
    candidate.protocolVersion !== PHASE_ZERO_PROTOCOL_VERSION ||
    candidate.requestId !== requestId
  ) {
    return undefined;
  }
  if (candidate.kind === "cancelled" || candidate.kind === "error") {
    return candidate as PhaseZeroWorkerResponse;
  }
  if (
    candidate.kind === "complete" &&
    candidate.payload instanceof ArrayBuffer &&
    isRevision(candidate.revision) &&
    candidate.byteLength === candidate.payload.byteLength &&
    candidate.byteLength <= PHASE_ZERO_MAX_REQUEST_BYTES
  ) {
    return candidate as PhaseZeroWorkerResponse;
  }
  return undefined;
}

function isRevision(value: unknown): value is PhaseZeroRevision {
  if (typeof value !== "object" || value === null) return false;
  const revision = value as Partial<PhaseZeroRevision>;
  return (
    typeof revision.scene === "number" && typeof revision.layout === "number"
  );
}

function sameRevision(
  left: PhaseZeroRevision,
  right: PhaseZeroRevision,
): boolean {
  return left.scene === right.scene && left.layout === right.layout;
}
