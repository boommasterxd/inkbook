import { describe, expect, it, vi } from "vitest";

import {
  StaleWorkerResultError,
  WORKER_ADMISSION_BYTES,
  WORKER_PROTOCOL_VERSION,
  WorkerCrashedError,
  type ByteWorkerRequest,
  type WorkerRevision,
} from "../../../src/workers/scheduler/protocol";
import type { LaunchedBrowserWorker } from "../../../src/workers/scheduler/browser-worker-adapter";
import type {
  StructuredWorkerWork,
  TypedWorkerWork,
  WorkerFallbackProcessor,
  WorkerFallbackWork,
} from "../../../src/workers/scheduler/scheduler";
import { ByteWorkerScheduler } from "../../../src/workers/scheduler/scheduler";
import { ManualSlices } from "./support";

const CURRENT_REVISION: WorkerRevision = { scene: 3, layout: 5 };
const SHA256_BYTES = 32;
const SOURCE_MAP_BYTES = 4_194_304;
const SOURCE_MAP_SCRATCH_BYTES = 8_388_608;
const MAX_SCHEDULER_BYTES = 16_777_216;
const MAX_RESERVED_BYTES = 67_108_864;
const CANONICAL_FIRST_BYTE = 17;
const CANONICAL_LAST_BYTE = 23;
const DIGEST_INPUT_BYTE = 7;
const BYTE_TWO = 2;
const BYTE_THREE = 3;
const BYTE_FOUR = 4;
const BYTE_FIVE = 5;
const LAST_ITEM_OFFSET = -1;
const SMALL_INPUT = new Uint8Array([1, BYTE_TWO, BYTE_THREE]);

class ControlledWorker extends EventTarget {
  public readonly posted: ByteWorkerRequest[] = [];
  public readonly transfers: Transferable[][] = [];
  public terminate = vi.fn<() => void>();
  public throwOnCancel = false;

  public postMessage(
    message: ByteWorkerRequest,
    transfer: Transferable[] = [],
  ): void {
    if (message.kind === "cancel" && this.throwOnCancel) {
      throw new Error("cancel transport failed");
    }
    this.posted.push(structuredClone(message, { transfer }));
    this.transfers.push(transfer);
  }

  public complete(
    requestId: number,
    revision: WorkerRevision,
    output: Uint8Array<ArrayBuffer>,
  ): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: WORKER_PROTOCOL_VERSION,
          kind: "complete",
          requestId,
          revision,
          byteLength: output.byteLength,
          payload: output.buffer,
        },
      }),
    );
  }

  public crash(): void {
    this.dispatchEvent(new Event("error"));
  }

  public completeStructured(
    requestId: number,
    revision: WorkerRevision,
    payload: unknown,
    byteLength: number,
  ): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: WORKER_PROTOCOL_VERSION,
          kind: "structured-complete",
          requestId,
          revision,
          payload,
          byteLength,
        },
      }),
    );
  }
}

function copyFallback(work: WorkerFallbackWork): WorkerFallbackProcessor {
  const output =
    work.kind === "source-digest"
      ? new Uint8Array(SHA256_BYTES)
      : new Uint8Array(work.input.byteLength);
  let offset = 0;
  return {
    processNext: (): boolean => {
      if (offset >= work.input.length) return true;
      if (work.kind !== "source-digest") {
        output[offset] = work.input[offset] ?? 0;
      }
      offset += 1;
      return offset === work.input.length;
    },
    complete: (): Uint8Array<ArrayBuffer> => output,
  };
}

interface SchedulerHarness {
  readonly scheduler: ByteWorkerScheduler;
  readonly slices: ManualSlices;
  readonly worker: ControlledWorker;
  readonly launch: ReturnType<
    typeof vi.fn<() => LaunchedBrowserWorker | undefined>
  >;
  readonly disposeWorker: ReturnType<typeof vi.fn<() => void>>;
}

function createHarness(
  workerAvailable = true,
  now: () => number = (): number => 0,
): SchedulerHarness {
  const worker = new ControlledWorker();
  const slices = new ManualSlices();
  const disposeWorker = vi.fn<() => void>(() => worker.terminate());
  const launch = vi.fn<() => LaunchedBrowserWorker | undefined>(() =>
    workerAvailable
      ? ({ worker, dispose: disposeWorker } as unknown as LaunchedBrowserWorker)
      : undefined,
  );
  return {
    worker,
    slices,
    launch,
    disposeWorker,
    scheduler: new ByteWorkerScheduler({
      launchWorker: launch,
      clock: { now },
      slices,
      isCurrent: (revision): boolean => revision === CURRENT_REVISION,
      processFallbackByte: (value): number => value,
      createFallbackProcessor: copyFallback,
      maxOutstandingBytes: MAX_SCHEDULER_BYTES,
      maxReservedBytes: MAX_RESERVED_BYTES,
    }),
  };
}

function persistenceWork(input: Uint8Array): TypedWorkerWork {
  return {
    kind: "persistence-encode",
    input,
    revision: CURRENT_REVISION,
    priority: "background",
    mode: "idle",
    maxOutputBytes: input.byteLength,
    scratchBytes: 0,
  };
}

function structuredNumberWork(
  payload: unknown,
  normalizeResult: (value: unknown) => number,
): StructuredWorkerWork<number> {
  return {
    kind: "persistence-encode",
    payload,
    inputBytes: WORKER_ADMISSION_BYTES,
    revision: CURRENT_REVISION,
    priority: "background",
    mode: "idle",
    maxOutputBytes: 1,
    scratchBytes: 0,
    createFallbackProcessor: (): WorkerFallbackProcessor<number> => ({
      processNext: (): boolean => true,
      complete: (): number => 0,
    }),
    normalizeResult,
  };
}

describe("typed worker admission", () => {
  it("uses sliced fallback immediately below the threshold", async () => {
    const { launch, scheduler, slices } = createHarness();
    const submission = scheduler.submitWork(
      persistenceWork(new Uint8Array(WORKER_ADMISSION_BYTES - 1)),
    );

    expect(launch).not.toHaveBeenCalled();
    submission.cancel();
    slices.flushAll();

    await expect(submission.result).rejects.toMatchObject({
      name: "AbortError",
    });
    scheduler.dispose();
  });

  it("advances typed fallback only inside controlled slice budgets", async () => {
    let time = 0;
    const { scheduler, slices } = createHarness(false, (): number => time++);
    const submission = scheduler.submitWork({
      ...persistenceWork(Uint8Array.from(SMALL_INPUT)),
      mode: "active",
    });

    slices.flushOne();
    expect(slices.modes).toEqual(["active", "active"]);
    slices.flushAll();

    await expect(submission.result).resolves.toEqual(SMALL_INPUT);
    scheduler.dispose();
  });

  it.each([WORKER_ADMISSION_BYTES, WORKER_ADMISSION_BYTES + 1])(
    "uses the worker at the %i-byte boundary",
    async (inputBytes) => {
      const { launch, scheduler, worker } = createHarness();
      const canonical = new Uint8Array(inputBytes);
      canonical[0] = CANONICAL_FIRST_BYTE;
      canonical[inputBytes - 1] = CANONICAL_LAST_BYTE;
      const submission = scheduler.submitWork(persistenceWork(canonical));
      const request = worker.posted[0];

      expect(launch).toHaveBeenCalledOnce();
      expect(request?.kind).toBe("process");
      if (request?.kind !== "process")
        throw new Error("Expected work request.");
      expect(request.workKind).toBe("persistence-encode");
      expect(request.maxOutputBytes).toBe(inputBytes);
      expect(request.scratchBytes).toBe(0);
      expect(canonical.buffer.byteLength).toBe(inputBytes);
      expect([canonical[0], canonical[inputBytes - 1]]).toEqual([
        CANONICAL_FIRST_BYTE,
        CANONICAL_LAST_BYTE,
      ]);
      worker.complete(
        request.requestId,
        request.revision,
        new Uint8Array(inputBytes),
      );

      await expect(submission.result).resolves.toHaveLength(inputBytes);
      expect(worker.transfers[0]).toHaveLength(1);
      scheduler.dispose();
    },
  );

  it("accepts every closed Phase 2 work kind", () => {
    const { scheduler } = createHarness(false);
    const kinds = [
      "source-digest",
      "source-map-compose",
      "source-map-compact",
      "persistence-encode",
      "persistence-parse",
    ] as const;
    const submissions = [];
    for (const kind of kinds) {
      const submission = scheduler.submitWork({
        kind,
        input: new Uint8Array([1]),
        revision: CURRENT_REVISION,
        priority: "background",
        mode: "idle",
        maxOutputBytes: kind === "source-digest" ? SHA256_BYTES : 1,
        scratchBytes: 0,
      });
      submissions.push(submission);
      void submission.result.catch(() => undefined);
    }
    expect(submissions).toHaveLength(kinds.length);
    scheduler.dispose();
  });
});

describe("typed worker result safety", () => {
  it("accepts the bounded digest output without detaching canonical input", async () => {
    const { scheduler, worker } = createHarness();
    const canonical = new Uint8Array(WORKER_ADMISSION_BYTES).fill(
      DIGEST_INPUT_BYTE,
    );
    const submission = scheduler.submitWork({
      kind: "source-digest",
      input: canonical,
      revision: CURRENT_REVISION,
      priority: "current",
      mode: "active",
      maxOutputBytes: SHA256_BYTES,
      scratchBytes: 262_144,
    });
    const request = worker.posted[0];
    if (request?.kind !== "process") throw new Error("Expected work request.");
    worker.complete(
      request.requestId,
      request.revision,
      new Uint8Array(SHA256_BYTES),
    );

    await expect(submission.result).resolves.toHaveLength(SHA256_BYTES);
    expect(canonical.buffer.byteLength).toBe(WORKER_ADMISSION_BYTES);
    expect(canonical[0]).toBe(DIGEST_INPUT_BYTE);
    scheduler.dispose();
  });

  it("rejects wrong-sized digest output and stale revisions", async () => {
    const wrongSize = createHarness();
    const invalid = wrongSize.scheduler.submitWork({
      kind: "source-digest",
      input: new Uint8Array(WORKER_ADMISSION_BYTES),
      revision: CURRENT_REVISION,
      priority: "current",
      mode: "active",
      maxOutputBytes: SHA256_BYTES,
      scratchBytes: 0,
    });
    const invalidRequest = wrongSize.worker.posted[0];
    if (invalidRequest?.kind !== "process")
      throw new Error("Expected request.");
    wrongSize.worker.complete(
      invalidRequest.requestId,
      invalidRequest.revision,
      new Uint8Array(SHA256_BYTES - 1),
    );
    await expect(invalid.result).rejects.toThrow("work bounds");
    wrongSize.scheduler.dispose();

    const stale = createHarness();
    const staleSubmission = stale.scheduler.submitWork(
      persistenceWork(new Uint8Array(WORKER_ADMISSION_BYTES)),
    );
    const staleRequest = stale.worker.posted[0];
    if (staleRequest?.kind !== "process") throw new Error("Expected request.");
    stale.worker.complete(
      staleRequest.requestId,
      { scene: CURRENT_REVISION.scene + 1, layout: CURRENT_REVISION.layout },
      new Uint8Array(WORKER_ADMISSION_BYTES),
    );
    await expect(staleSubmission.result).rejects.toBeInstanceOf(
      StaleWorkerResultError,
    );
    stale.scheduler.dispose();
  });

  it("releases a crashed worker and routes later work through slices", async () => {
    const { disposeWorker, scheduler, slices, worker } = createHarness();
    const crashed = scheduler.submitWork(
      persistenceWork(new Uint8Array(WORKER_ADMISSION_BYTES)),
    );

    worker.crash();

    await expect(crashed.result).rejects.toBeInstanceOf(WorkerCrashedError);
    expect(disposeWorker).toHaveBeenCalledOnce();
    const recovered = scheduler.submitWork(
      persistenceWork(Uint8Array.from(SMALL_INPUT)),
    );
    slices.flushAll();
    await expect(recovered.result).resolves.toEqual(SMALL_INPUT);
    scheduler.dispose();
  });
});

describe("typed worker resource profiles", () => {
  it("accepts exact source-map bounds", () => {
    const { scheduler } = createHarness();
    const canonical = new Uint8Array(SOURCE_MAP_BYTES);
    const accepted = scheduler.submitWork({
      kind: "source-map-compact",
      input: canonical,
      revision: CURRENT_REVISION,
      priority: "background",
      mode: "idle",
      maxOutputBytes: SOURCE_MAP_BYTES,
      scratchBytes: SOURCE_MAP_SCRATCH_BYTES,
    });
    void accepted.result.catch(() => undefined);

    expect(canonical.buffer.byteLength).toBe(SOURCE_MAP_BYTES);
    scheduler.dispose();
  });

  it("rejects input, output, scratch, and digest reservations above limits", () => {
    const { scheduler } = createHarness(false);
    const base = {
      kind: "source-map-compose" as const,
      input: new Uint8Array([1]),
      revision: CURRENT_REVISION,
      priority: "background" as const,
      mode: "idle" as const,
    };

    expect(() =>
      scheduler.submitWork({
        ...base,
        input: new Uint8Array(SOURCE_MAP_BYTES + 1),
        maxOutputBytes: 1,
        scratchBytes: 0,
      }),
    ).toThrow(RangeError);
    expect(() =>
      scheduler.submitWork({
        ...base,
        maxOutputBytes: SOURCE_MAP_BYTES + 1,
        scratchBytes: 0,
      }),
    ).toThrow(RangeError);
    expect(() =>
      scheduler.submitWork({
        ...base,
        maxOutputBytes: 1,
        scratchBytes: SOURCE_MAP_SCRATCH_BYTES + 1,
      }),
    ).toThrow(RangeError);
    expect(() =>
      scheduler.submitWork({
        ...base,
        kind: "source-digest",
        maxOutputBytes: SHA256_BYTES - 1,
        scratchBytes: 0,
      }),
    ).toThrow(RangeError);
    scheduler.dispose();
  });
});

describe("structured worker result safety", () => {
  it("normalizes semantic output and fails closed on a matching malformed response", async () => {
    const { launch, scheduler, worker } = createHarness();
    const valid = scheduler.submitStructured(
      structuredNumberWork({ operation: "encode" }, (value): number => {
        if (typeof value !== "number") throw new TypeError("invalid result");
        return value + 1;
      }),
    );
    const request = worker.posted[0];
    if (request?.kind !== "process-structured") {
      throw new Error("Expected structured work.");
    }
    worker.completeStructured(
      request.requestId,
      request.revision,
      BYTE_FOUR,
      1,
    );
    await expect(valid.result).resolves.toBe(BYTE_FIVE);

    const malformed = scheduler.submitStructured(
      structuredNumberWork({}, (value): number => Number(value)),
    );
    const malformedRequest = worker.posted.at(LAST_ITEM_OFFSET);
    if (malformedRequest?.kind !== "process-structured") {
      throw new Error("Expected structured work.");
    }
    worker.completeStructured(
      malformedRequest.requestId,
      malformedRequest.revision,
      1,
      malformedRequest.maxOutputBytes + 1,
    );
    await expect(malformed.result).rejects.toThrow("protocol");
    expect(launch).toHaveBeenCalledOnce();
    scheduler.dispose();
  });

  it("releases reservations when cancellation transport throws", async () => {
    const { disposeWorker, scheduler, worker } = createHarness();
    const submission = scheduler.submitWork(
      persistenceWork(new Uint8Array(WORKER_ADMISSION_BYTES)),
    );
    worker.throwOnCancel = true;
    submission.cancel();

    await expect(submission.result).rejects.toBeInstanceOf(WorkerCrashedError);
    expect(disposeWorker).toHaveBeenCalledOnce();
    scheduler.dispose();
  });
});
