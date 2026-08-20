import { describe, expect, it, vi } from "vitest";

import {
  MAX_WORKER_REQUEST_BYTES,
  StaleWorkerResultError,
  WORKER_PROTOCOL_VERSION,
  WorkerCrashedError,
  WorkerDisposedError,
  WorkerQueueExhaustedError,
  type ByteWorkerRequest,
  type WorkerRevision,
} from "../../../src/workers/scheduler/protocol";
import type { LaunchedBrowserWorker } from "../../../src/workers/scheduler/browser-worker-adapter";
import {
  ByteWorkerScheduler,
  type WorkerSliceScheduler,
} from "../../../src/workers/scheduler/scheduler";
import { ManualSlices } from "./support";

const CURRENT_REVISION: WorkerRevision = { scene: 7, layout: 11 };
const BYTE_TWO = 2;
const BYTE_THREE = 3;
const BYTE_FOUR = 4;
const BYTE_FIVE = 5;
const BYTE_254 = 254;
const BYTE_255 = 255;
const MAX_OUTSTANDING_REQUESTS = 64;
const MAX_OUTSTANDING_BYTES = 16_777_216;
const NEGATIVE_ONE = -1;
const copyByte = (value: number): number => value;

class ManualWorker extends EventTarget {
  public readonly posted: ByteWorkerRequest[] = [];
  public readonly transfers: Transferable[][] = [];
  public autoComplete = false;
  public terminate = vi.fn<() => void>();

  public postMessage(
    message: ByteWorkerRequest,
    transfer: Transferable[] = [],
  ): void {
    const received = structuredClone(message, { transfer });
    this.posted.push(received);
    this.transfers.push(transfer);
    if (this.autoComplete && received.kind === "process") {
      const input = new Uint8Array(received.payload);
      const output = Uint8Array.from(input);
      queueMicrotask(() =>
        this.complete(received.requestId, received.revision, output.buffer),
      );
    }
  }

  public complete(
    requestId: number,
    revision: WorkerRevision,
    payload: ArrayBuffer,
  ): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: WORKER_PROTOCOL_VERSION,
          kind: "complete",
          requestId,
          revision,
          byteLength: payload.byteLength,
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

function createWorkerHarness(autoComplete = false): {
  readonly worker: ManualWorker;
  readonly disposeWorker: ReturnType<typeof vi.fn<() => void>>;
  readonly scheduler: ByteWorkerScheduler;
  readonly slices: ManualSlices;
} {
  const worker = new ManualWorker();
  worker.autoComplete = autoComplete;
  const disposeWorker = vi.fn<() => void>(() => worker.terminate());
  const slices = new ManualSlices();
  const scheduler = new ByteWorkerScheduler({
    launchWorker: (): LaunchedBrowserWorker =>
      ({ worker, dispose: disposeWorker }) as unknown as LaunchedBrowserWorker,
    clock: { now: (): number => 0 },
    slices,
    isCurrent: (revision): boolean => revision === CURRENT_REVISION,
    processFallbackByte: copyByte,
  });
  return { worker, disposeWorker, scheduler, slices };
}

function createFallbackHarness(
  clock: () => number,
  isCurrent = true,
  processFallbackByte = copyByte,
): {
  readonly scheduler: ByteWorkerScheduler;
  readonly slices: ManualSlices;
} {
  const slices = new ManualSlices();
  const scheduler = new ByteWorkerScheduler({
    launchWorker: (): undefined => undefined,
    clock: { now: clock },
    slices,
    isCurrent: (): boolean => isCurrent,
    processFallbackByte,
  });
  return { scheduler, slices };
}

describe("ByteWorkerScheduler worker execution", () => {
  it("launches lazily, transfers staging ownership, and returns bounded output", async () => {
    const { worker, scheduler } = createWorkerHarness(true);
    const input = new Uint8Array([0, 1, BYTE_254, BYTE_255]);

    const submission = scheduler.submit(
      input,
      CURRENT_REVISION,
      "current",
      "active",
    );

    expect(input.buffer.byteLength).toBe(0);
    await expect(submission.result).resolves.toEqual(
      new Uint8Array([0, 1, BYTE_254, BYTE_255]),
    );
    expect(worker.transfers[0]).toHaveLength(1);
    scheduler.dispose();
  });

  it("sends cancellation and rejects only after the worker observes it", async () => {
    const { worker, scheduler } = createWorkerHarness();
    const submission = scheduler.submit(
      new Uint8Array([1]),
      CURRENT_REVISION,
      "current",
      "active",
    );

    submission.cancel();
    const cancel = worker.posted.at(worker.posted.length - 1);
    expect(cancel?.kind).toBe("cancel");
    if (cancel?.kind === "cancel") worker.cancelRequest(cancel.requestId);

    await expect(submission.result).rejects.toMatchObject({
      name: "AbortError",
    });
    scheduler.dispose();
  });

  it("removes a cancelled queued request before it reaches the worker", async () => {
    const { scheduler } = createWorkerHarness();
    const active = scheduler.submit(
      new Uint8Array([1]),
      CURRENT_REVISION,
      "current",
      "active",
    );
    void active.result.catch(() => undefined);
    const queued = scheduler.submit(
      new Uint8Array([BYTE_TWO]),
      CURRENT_REVISION,
      "background",
      "idle",
    );

    queued.cancel();

    await expect(queued.result).rejects.toMatchObject({ name: "AbortError" });
    scheduler.dispose();
  });
});

describe("ByteWorkerScheduler response handling", () => {
  it("rejects stale revisions and explicit worker errors", async () => {
    const staleHarness = createWorkerHarness();
    const stale = staleHarness.scheduler.submit(
      new Uint8Array([1]),
      CURRENT_REVISION,
      "current",
      "active",
    );
    const staleRequest = staleHarness.worker.posted[0];
    if (staleRequest?.kind === "process") {
      staleHarness.worker.complete(
        staleRequest.requestId,
        { scene: CURRENT_REVISION.scene + 1, layout: CURRENT_REVISION.layout },
        new Uint8Array([1]).buffer,
      );
    }
    await expect(stale.result).rejects.toBeInstanceOf(StaleWorkerResultError);
    staleHarness.scheduler.dispose();

    const errorHarness = createWorkerHarness();
    const failed = errorHarness.scheduler.submit(
      new Uint8Array([1]),
      CURRENT_REVISION,
      "current",
      "active",
    );
    const errorRequest = errorHarness.worker.posted[0];
    if (errorRequest !== undefined)
      errorHarness.worker.failRequest(errorRequest.requestId);
    await expect(failed.result).rejects.toThrow("processing failure");
    errorHarness.scheduler.dispose();
  });

  it("handles a crash, releases the worker, and uses fallback for later work", async () => {
    const { worker, disposeWorker, scheduler, slices } = createWorkerHarness();
    const crashed = scheduler.submit(
      new Uint8Array([1]),
      CURRENT_REVISION,
      "current",
      "active",
    );

    worker.crash();
    await expect(crashed.result).rejects.toBeInstanceOf(WorkerCrashedError);
    expect(disposeWorker).toHaveBeenCalledOnce();
    const recovered = scheduler.submit(
      new Uint8Array([1]),
      CURRENT_REVISION,
      "current",
      "active",
    );
    slices.flushAll();
    await expect(recovered.result).resolves.toEqual(new Uint8Array([1]));
    scheduler.dispose();
  });
});

describe("ByteWorkerScheduler configuration limits", () => {
  it("accepts the exact normative scheduler capacities", () => {
    const options: ConstructorParameters<typeof ByteWorkerScheduler>[0] = {
      launchWorker: (): undefined => undefined,
      clock: { now: (): number => 0 },
      slices: new ManualSlices(),
      isCurrent: (): boolean => true,
      processFallbackByte: copyByte,
      maxOutstandingRequests: MAX_OUTSTANDING_REQUESTS,
      maxOutstandingBytes: MAX_OUTSTANDING_BYTES,
    };

    const scheduler = new ByteWorkerScheduler(options);

    expect(scheduler).toBeInstanceOf(ByteWorkerScheduler);
    scheduler.dispose();
  });

  it.each([
    ["maxOutstandingRequests", MAX_OUTSTANDING_REQUESTS + 1],
    ["maxOutstandingRequests", Number.POSITIVE_INFINITY],
    ["maxOutstandingRequests", Number.NaN],
    ["maxOutstandingRequests", 0],
    ["maxOutstandingRequests", NEGATIVE_ONE],
    ["maxOutstandingBytes", MAX_OUTSTANDING_BYTES + 1],
    ["maxOutstandingBytes", Number.POSITIVE_INFINITY],
    ["maxOutstandingBytes", Number.NaN],
    ["maxOutstandingBytes", 0],
    ["maxOutstandingBytes", NEGATIVE_ONE],
  ] as const)(
    "rejects invalid %s value %s before retaining resources",
    (key, value) => {
      const launchWorker = vi.fn<() => undefined>();
      const schedule = vi.fn<WorkerSliceScheduler["schedule"]>();
      const options: ConstructorParameters<typeof ByteWorkerScheduler>[0] = {
        launchWorker,
        clock: { now: (): number => 0 },
        slices: { schedule },
        isCurrent: (): boolean => true,
        processFallbackByte: copyByte,
        [key]: value,
      };

      expect(() => new ByteWorkerScheduler(options)).toThrow(RangeError);
      expect(launchWorker).not.toHaveBeenCalled();
      expect(schedule).not.toHaveBeenCalled();
    },
  );
});

describe("ByteWorkerScheduler resource limits", () => {
  it("enforces request, queue, and byte limits under abuse", () => {
    const { scheduler } = createWorkerHarness();
    const constrained = new ByteWorkerScheduler({
      launchWorker: (): undefined => undefined,
      clock: { now: (): number => 0 },
      slices: new ManualSlices(),
      isCurrent: (): boolean => true,
      processFallbackByte: copyByte,
      maxOutstandingRequests: 1,
      maxOutstandingBytes: BYTE_TWO,
    });
    const accepted = constrained.submit(
      new Uint8Array([1, BYTE_TWO]),
      CURRENT_REVISION,
      "current",
      "idle",
    );
    void accepted.result.catch(() => undefined);

    expect(() =>
      constrained.submit(
        new Uint8Array([BYTE_THREE]),
        CURRENT_REVISION,
        "current",
        "idle",
      ),
    ).toThrow(WorkerQueueExhaustedError);
    expect(() =>
      scheduler.submit(
        new Uint8Array(MAX_WORKER_REQUEST_BYTES + 1),
        CURRENT_REVISION,
        "current",
        "idle",
      ),
    ).toThrow(RangeError);
    constrained.dispose();
    scheduler.dispose();
  });

  it("disposes active work and the worker idempotently", async () => {
    const { disposeWorker, scheduler } = createWorkerHarness();
    const submission = scheduler.submit(
      new Uint8Array([1]),
      CURRENT_REVISION,
      "current",
      "active",
    );

    scheduler.dispose();
    scheduler.dispose();

    await expect(submission.result).rejects.toBeInstanceOf(WorkerDisposedError);
    expect(disposeWorker).toHaveBeenCalledOnce();
    expect(() =>
      scheduler.submit(
        new Uint8Array([1]),
        CURRENT_REVISION,
        "current",
        "active",
      ),
    ).toThrow(WorkerDisposedError);
  });

  it("rejects views that do not own their complete staging buffer", () => {
    const { scheduler } = createWorkerHarness();
    const backing = new Uint8Array([1, BYTE_TWO]);
    const partial = backing.subarray(1);

    expect(() =>
      scheduler.submit(partial, CURRENT_REVISION, "current", "active"),
    ).toThrow(RangeError);
    scheduler.dispose();
  });
});

describe("ByteWorkerScheduler sliced fallback", () => {
  it("uses deterministic 2 ms active and 4 ms idle slice budgets", async () => {
    let time = 0;
    const { scheduler, slices } = createFallbackHarness((): number => time++);
    const active = scheduler.submit(
      new Uint8Array([0, 1, BYTE_TWO, BYTE_THREE]),
      CURRENT_REVISION,
      "current",
      "active",
    );
    slices.flushAll();
    await expect(active.result).resolves.toEqual(
      new Uint8Array([0, 1, BYTE_TWO, BYTE_THREE]),
    );

    time = 0;
    const idle = scheduler.submit(
      new Uint8Array([BYTE_FOUR, BYTE_FIVE]),
      CURRENT_REVISION,
      "current",
      "idle",
    );
    slices.flushAll();
    await expect(idle.result).resolves.toEqual(
      new Uint8Array([BYTE_FOUR, BYTE_FIVE]),
    );
    expect(slices.modes).toContain("active");
    expect(slices.modes).toContain("idle");
    scheduler.dispose();
  });

  it("observes cancellation between fallback chunks without partial publication", async () => {
    let time = 0;
    const { scheduler, slices } = createFallbackHarness((): number => time++);
    const submission = scheduler.submit(
      new Uint8Array([1, BYTE_TWO, BYTE_THREE]),
      CURRENT_REVISION,
      "current",
      "active",
    );

    slices.flushOne();
    submission.cancel();
    slices.flushOne();

    await expect(submission.result).rejects.toMatchObject({
      name: "AbortError",
    });
    scheduler.dispose();
  });

  it("discards completed fallback work when its revision is no longer current", async () => {
    const { scheduler, slices } = createFallbackHarness((): number => 0, false);
    const submission = scheduler.submit(
      new Uint8Array([1]),
      CURRENT_REVISION,
      "current",
      "idle",
    );

    slices.flushAll();

    await expect(submission.result).rejects.toBeInstanceOf(
      StaleWorkerResultError,
    );
    scheduler.dispose();
  });

  it("rejects fallback processor failures without publishing partial output", async () => {
    const failure = new Error("byte processor failed");
    const { scheduler, slices } = createFallbackHarness(
      (): number => 0,
      true,
      (): never => {
        throw failure;
      },
    );
    const submission = scheduler.submit(
      new Uint8Array([1]),
      CURRENT_REVISION,
      "current",
      "idle",
    );

    slices.flushAll();

    await expect(submission.result).rejects.toBe(failure);
    scheduler.dispose();
  });
});
