/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact scheduler boundaries are intentional. */
import { describe, expect, it, vi } from "vitest";

import type { LaunchedBrowserWorker } from "../../../src/workers/scheduler/browser-worker-adapter";
import {
  StaleWorkerResultError,
  WORKER_ADMISSION_BYTES,
  WORKER_PROTOCOL_VERSION,
  WorkerCrashedError,
  WorkerDisposedError,
  WorkerQueueExhaustedError,
  type StructuredWorkRequest,
  type WorkerRequest,
  type WorkerRevision,
} from "../../../src/workers/scheduler/protocol";
import {
  ByteWorkerScheduler,
  type StructuredWorkerWork,
  type WorkerSliceScheduler,
} from "../../../src/workers/scheduler/scheduler";
import type { WorkerFallbackProcessor } from "../../../src/workers/scheduler/scheduler-types";
import { ManualSlices } from "./support";

const CURRENT_REVISION: WorkerRevision = { scene: 7, layout: 11 };
const MAX_OUTSTANDING_REQUESTS = 64;
const MAX_OUTSTANDING_BYTES = 16_777_216;

class ManualWorker extends EventTarget {
  public readonly posted: WorkerRequest[] = [];
  public terminate = vi.fn<() => void>();
  public throwOnCancel = false;

  public postMessage(message: WorkerRequest): void {
    if (message.kind === "cancel" && this.throwOnCancel) {
      throw new Error("cancel transport failed");
    }
    this.posted.push(structuredClone(message));
  }

  public complete(
    requestId: number,
    revision: WorkerRevision,
    payload: unknown,
    byteLength = 1,
  ): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: WORKER_PROTOCOL_VERSION,
          kind: "structured-complete",
          requestId,
          revision,
          byteLength,
          payload,
        },
      }),
    );
  }

  public failRequest(requestId: number): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: WORKER_PROTOCOL_VERSION,
          kind: "error",
          requestId,
          message: "processing failure",
        },
      }),
    );
  }

  public cancelRequest(requestId: number): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: WORKER_PROTOCOL_VERSION,
          kind: "cancelled",
          requestId,
        },
      }),
    );
  }

  public crash(): void {
    this.dispatchEvent(new Event("error"));
  }
}

interface Harness {
  readonly worker: ManualWorker;
  readonly disposeWorker: ReturnType<typeof vi.fn<() => void>>;
  readonly launch: ReturnType<
    typeof vi.fn<() => LaunchedBrowserWorker | undefined>
  >;
  readonly scheduler: ByteWorkerScheduler;
  readonly slices: ManualSlices;
}

function createHarness(
  workerAvailable = true,
  now: () => number = (): number => 0,
  isCurrent: (revision: WorkerRevision) => boolean = (revision): boolean =>
    revision === CURRENT_REVISION,
): Harness {
  const worker = new ManualWorker();
  const disposeWorker = vi.fn<() => void>(() => worker.terminate());
  const launch = vi.fn<() => LaunchedBrowserWorker | undefined>(() =>
    workerAvailable
      ? ({ worker, dispose: disposeWorker } as unknown as LaunchedBrowserWorker)
      : undefined,
  );
  const slices = new ManualSlices();
  return {
    worker,
    disposeWorker,
    launch,
    slices,
    scheduler: new ByteWorkerScheduler({
      launchWorker: launch,
      clock: { now },
      slices,
      isCurrent,
    }),
  };
}

function numberWork(
  inputBytes: number,
  options: {
    readonly mode?: "active" | "idle";
    readonly priority?: "current" | "background";
    readonly workerFirst?: boolean;
    readonly completeAfter?: number;
    readonly result?: number;
    readonly normalize?: (value: unknown) => number;
  } = {},
): StructuredWorkerWork<number> {
  const result = options.result ?? 1;
  let remaining = options.completeAfter ?? 1;
  return {
    kind: "persistence-encode",
    payload: { wireVersion: 1, result },
    inputBytes,
    revision: CURRENT_REVISION,
    priority: options.priority ?? "background",
    mode: options.mode ?? "idle",
    maxOutputBytes: Math.max(1, inputBytes),
    scratchBytes: 0,
    ...(options.workerFirst === undefined
      ? {}
      : { workerFirst: options.workerFirst }),
    createFallbackProcessor: (): WorkerFallbackProcessor<number> => ({
      processNext: (): boolean => --remaining <= 0,
      complete: (): number => result,
    }),
    normalizeResult:
      options.normalize ??
      ((value): number => {
        if (typeof value !== "number") throw new TypeError("invalid result");
        return value;
      }),
  };
}

function requestFrom(worker: ManualWorker, index = 0): StructuredWorkRequest {
  const request = worker.posted[index];
  if (request?.kind !== "process-structured") {
    throw new Error("Expected structured request.");
  }
  return request;
}

describe("structured worker execution", () => {
  it("launches lazily at the admission boundary and normalizes output", async () => {
    const { launch, scheduler, worker } = createHarness();
    const submission = scheduler.submitStructured(
      numberWork(WORKER_ADMISSION_BYTES, {
        normalize: (value): number => Number(value) + 1,
      }),
    );
    const request = requestFrom(worker);

    expect(launch).toHaveBeenCalledOnce();
    expect(request.workKind).toBe("persistence-encode");
    worker.complete(request.requestId, request.revision, 4);

    await expect(submission.result).resolves.toBe(5);
    scheduler.dispose();
  });

  it("uses sliced fallback below admission and honors active slices", async () => {
    let time = 0;
    const { launch, scheduler, slices } = createHarness(
      true,
      (): number => time++,
    );
    const submission = scheduler.submitStructured(
      numberWork(WORKER_ADMISSION_BYTES - 1, {
        mode: "active",
        completeAfter: 4,
        result: 7,
      }),
    );

    expect(launch).not.toHaveBeenCalled();
    slices.flushAll();

    await expect(submission.result).resolves.toBe(7);
    expect(slices.modes).toContain("active");
    scheduler.dispose();
  });

  it("forces worker-first execution when explicitly requested", () => {
    const { launch, scheduler } = createHarness();
    const submission = scheduler.submitStructured(
      numberWork(1, { workerFirst: true }),
    );
    void submission.result.catch(() => undefined);

    expect(launch).toHaveBeenCalledOnce();
    scheduler.dispose();
  });

  it("sends cancellation and waits for worker acknowledgement", async () => {
    const { scheduler, worker } = createHarness();
    const submission = scheduler.submitStructured(
      numberWork(WORKER_ADMISSION_BYTES),
    );

    submission.cancel();
    const cancel = worker.posted.at(-1);
    expect(cancel?.kind).toBe("cancel");
    if (cancel?.kind === "cancel") worker.cancelRequest(cancel.requestId);

    await expect(submission.result).rejects.toMatchObject({
      name: "AbortError",
    });
    scheduler.dispose();
  });

  it("removes queued cancellation before worker delivery", async () => {
    const { scheduler } = createHarness();
    const active = scheduler.submitStructured(
      numberWork(WORKER_ADMISSION_BYTES),
    );
    void active.result.catch(() => undefined);
    const queued = scheduler.submitStructured(
      numberWork(WORKER_ADMISSION_BYTES, { priority: "background" }),
    );

    queued.cancel();

    await expect(queued.result).rejects.toMatchObject({ name: "AbortError" });
    scheduler.dispose();
  });
});

describe("structured worker failures", () => {
  it("rejects stale revisions and explicit worker errors", async () => {
    const staleHarness = createHarness();
    const stale = staleHarness.scheduler.submitStructured(
      numberWork(WORKER_ADMISSION_BYTES),
    );
    const staleRequest = requestFrom(staleHarness.worker);
    staleHarness.worker.complete(
      staleRequest.requestId,
      { ...CURRENT_REVISION, scene: CURRENT_REVISION.scene + 1 },
      1,
    );
    await expect(stale.result).rejects.toBeInstanceOf(StaleWorkerResultError);
    staleHarness.scheduler.dispose();

    const errorHarness = createHarness();
    const failed = errorHarness.scheduler.submitStructured(
      numberWork(WORKER_ADMISSION_BYTES),
    );
    errorHarness.worker.failRequest(requestFrom(errorHarness.worker).requestId);
    await expect(failed.result).rejects.toThrow("processing failure");
    errorHarness.scheduler.dispose();
  });

  it("releases a crashed worker and falls back for later work", async () => {
    const { disposeWorker, scheduler, slices, worker } = createHarness();
    const crashed = scheduler.submitStructured(
      numberWork(WORKER_ADMISSION_BYTES),
    );

    worker.crash();

    await expect(crashed.result).rejects.toBeInstanceOf(WorkerCrashedError);
    expect(disposeWorker).toHaveBeenCalledOnce();
    const recovered = scheduler.submitStructured(numberWork(1, { result: 9 }));
    slices.flushAll();
    await expect(recovered.result).resolves.toBe(9);
    scheduler.dispose();
  });

  it("fails closed on malformed output and cancel transport failure", async () => {
    const malformedHarness = createHarness();
    const malformed = malformedHarness.scheduler.submitStructured(
      numberWork(WORKER_ADMISSION_BYTES),
    );
    const malformedRequest = requestFrom(malformedHarness.worker);
    malformedHarness.worker.complete(
      malformedRequest.requestId,
      malformedRequest.revision,
      1,
      malformedRequest.maxOutputBytes + 1,
    );
    await expect(malformed.result).rejects.toThrow("protocol");
    malformedHarness.scheduler.dispose();

    const cancelHarness = createHarness();
    const cancelled = cancelHarness.scheduler.submitStructured(
      numberWork(WORKER_ADMISSION_BYTES),
    );
    cancelHarness.worker.throwOnCancel = true;
    cancelled.cancel();
    await expect(cancelled.result).rejects.toBeInstanceOf(WorkerCrashedError);
    expect(cancelHarness.disposeWorker).toHaveBeenCalledOnce();
    cancelHarness.scheduler.dispose();
  });
});

describe("structured worker limits and lifecycle", () => {
  it("accepts normative capacities and rejects invalid configuration", () => {
    const options: ConstructorParameters<typeof ByteWorkerScheduler>[0] = {
      launchWorker: (): undefined => undefined,
      clock: { now: (): number => 0 },
      slices: new ManualSlices(),
      isCurrent: (): boolean => true,
      maxOutstandingRequests: MAX_OUTSTANDING_REQUESTS,
      maxOutstandingBytes: MAX_OUTSTANDING_BYTES,
    };
    const scheduler = new ByteWorkerScheduler(options);
    scheduler.dispose();

    for (const [key, value] of [
      ["maxOutstandingRequests", MAX_OUTSTANDING_REQUESTS + 1],
      ["maxOutstandingRequests", Number.POSITIVE_INFINITY],
      ["maxOutstandingRequests", Number.NaN],
      ["maxOutstandingRequests", 0],
      ["maxOutstandingRequests", -1],
      ["maxOutstandingBytes", MAX_OUTSTANDING_BYTES + 1],
      ["maxOutstandingBytes", 0],
    ] as const) {
      const launchWorker = vi.fn<() => undefined>();
      const schedule = vi.fn<WorkerSliceScheduler["schedule"]>();
      expect(
        () =>
          new ByteWorkerScheduler({
            ...options,
            launchWorker,
            slices: { schedule },
            [key]: value,
          }),
      ).toThrow(RangeError);
      expect(launchWorker).not.toHaveBeenCalled();
      expect(schedule).not.toHaveBeenCalled();
    }
  });

  it("enforces request, input-byte, and reservation limits", () => {
    const constrained = new ByteWorkerScheduler({
      launchWorker: (): undefined => undefined,
      clock: { now: (): number => 0 },
      slices: new ManualSlices(),
      isCurrent: (): boolean => true,
      maxOutstandingRequests: 1,
      maxOutstandingBytes: 2,
      maxReservedBytes: 4,
    });
    const accepted = constrained.submitStructured(numberWork(2));
    void accepted.result.catch(() => undefined);

    expect(() => constrained.submitStructured(numberWork(1))).toThrow(
      WorkerQueueExhaustedError,
    );
    constrained.dispose();

    const { scheduler } = createHarness(false);
    expect(() =>
      scheduler.submitStructured({
        ...numberWork(1),
        kind: "source-map-compose",
        inputBytes: 4_194_305,
      }),
    ).toThrow(RangeError);
    scheduler.dispose();
  });
});

describe("structured worker disposal", () => {
  it("disposes active work idempotently and rejects later submissions", async () => {
    const { disposeWorker, scheduler } = createHarness();
    const submission = scheduler.submitStructured(
      numberWork(WORKER_ADMISSION_BYTES),
    );

    scheduler.dispose();
    scheduler.dispose();

    await expect(submission.result).rejects.toBeInstanceOf(WorkerDisposedError);
    expect(disposeWorker).toHaveBeenCalledOnce();
    expect(() => scheduler.submitStructured(numberWork(1))).toThrow(
      WorkerDisposedError,
    );
  });

  it("discards completed fallback when its revision is stale", async () => {
    const { scheduler, slices } = createHarness(
      false,
      (): number => 0,
      (): boolean => false,
    );
    const submission = scheduler.submitStructured(numberWork(1));

    slices.flushAll();

    await expect(submission.result).rejects.toBeInstanceOf(
      StaleWorkerResultError,
    );
    scheduler.dispose();
  });

  it("cancels fallback between slices without partial publication", async () => {
    let time = 0;
    const { scheduler, slices } = createHarness(false, (): number => time++);
    const submission = scheduler.submitStructured(
      numberWork(1, { mode: "active", completeAfter: 10 }),
    );

    slices.flushOne();
    submission.cancel();

    await expect(submission.result).rejects.toMatchObject({
      name: "AbortError",
    });
    scheduler.dispose();
  });
});
