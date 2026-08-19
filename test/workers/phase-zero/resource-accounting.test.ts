import { describe, expect, it, vi } from "vitest";

import {
  RESOURCE_BUDGET_V1,
  RESOURCE_CATEGORIES_V1,
  ResourceCoordinatorV1,
  type ResourceBudgetProfileV1,
  type ResourceCategoryLimitV1,
  type ResourceCategoryV1,
} from "../../../src/application/resource-coordinator";
import {
  PHASE_ZERO_CHUNK_BYTES,
  PHASE_ZERO_PROTOCOL_VERSION,
  PhaseZeroWorkerScheduler,
  WorkerCrashedError,
  WorkerDisposedError,
  type LaunchedBrowserWorker,
  type PhaseZeroRevision,
  type PhaseZeroSliceMode,
  type PhaseZeroSliceScheduler,
  type PhaseZeroWorkerRequest,
} from "../../../src/workers/phase-zero";
import {
  createWorkerResourceContext,
  WorkerOwnerResources,
  WorkerTaskResources,
} from "../../../src/workers/phase-zero/resource-accounting";

const REVISION: PhaseZeroRevision = { layout: 3, scene: 2 };
const KIB = 1_024;
const WORKER_OWNER_KIB = 16;
const WORKER_OWNER_BYTES = WORKER_OWNER_KIB * KIB;
const LISTENER_BYTES = 512;
const WORKER_LISTENER_COUNT = 3;
const INPUT_BYTES = 4;
const BYTE_TWO = 2;
const BYTE_THREE = 3;

class LedgerWorker extends EventTarget {
  public readonly posted: PhaseZeroWorkerRequest[] = [];
  public throwOnKind: PhaseZeroWorkerRequest["kind"] | undefined;
  public terminate = vi.fn<() => void>();

  public postMessage(
    message: PhaseZeroWorkerRequest,
    transfer: Transferable[] = [],
  ): void {
    if (message.kind === this.throwOnKind) throw new Error("post failed");
    this.posted.push(structuredClone(message, { transfer }));
  }

  public complete(requestId: number, bytes: number): void {
    const payload = new Uint8Array(bytes).buffer;
    this.dispatchEvent(
      new MessageEvent("message", {
        data: {
          byteLength: bytes,
          kind: "complete",
          payload,
          protocolVersion: PHASE_ZERO_PROTOCOL_VERSION,
          requestId,
          revision: REVISION,
        },
      }),
    );
  }

  public cancel(requestId: number): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "cancelled",
          protocolVersion: PHASE_ZERO_PROTOCOL_VERSION,
          requestId,
        },
      }),
    );
  }

  public malformed(requestId: number): void {
    this.dispatchEvent(new MessageEvent("message", { data: { requestId } }));
  }

  public crash(): void {
    this.dispatchEvent(new Event("error"));
  }
}

class LedgerSlices implements PhaseZeroSliceScheduler {
  readonly #callbacks: (() => void)[] = [];
  public throwOnSchedule = false;

  public schedule(_mode: PhaseZeroSliceMode, callback: () => void): () => void {
    if (this.throwOnSchedule) throw new Error("schedule failed");
    this.#callbacks.push(callback);
    return (): void => {
      const index = this.#callbacks.indexOf(callback);
      if (index >= 0) this.#callbacks.splice(index, 1);
    };
  }

  public flushAll(): void {
    while (this.#callbacks.length > 0) this.#callbacks.shift()?.();
  }
}

interface Harness {
  readonly coordinator: ResourceCoordinatorV1;
  readonly scheduler: PhaseZeroWorkerScheduler;
  readonly slices: LedgerSlices;
  readonly worker: LedgerWorker;
}

function harness(
  configure?: (worker: LedgerWorker, slices: LedgerSlices) => void,
  launchThrows = false,
): Harness {
  const coordinator = new ResourceCoordinatorV1(
    RESOURCE_BUDGET_V1.androidPhone,
  );
  const worker = new LedgerWorker();
  const slices = new LedgerSlices();
  configure?.(worker, slices);
  const scheduler = new PhaseZeroWorkerScheduler({
    clock: { now: (): number => 0 },
    isCurrent: (): boolean => true,
    launchWorker: (): LaunchedBrowserWorker => {
      if (launchThrows) throw new Error("launch failed");
      return {
        worker,
        dispose: (): void => worker.terminate(),
      } as unknown as LaunchedBrowserWorker;
    },
    resourceCoordinator: coordinator,
    resourceOwnerId: "worker-test",
    slices,
  });
  return { coordinator, scheduler, slices, worker };
}

describe("phase-zero worker staging ownership", () => {
  it("reserves capacity before allocating a plugin-owned staging buffer", async () => {
    const { coordinator, scheduler, worker } = harness();
    const initialize = vi.fn((input: Uint8Array<ArrayBuffer>) => {
      expect(
        coordinator.snapshot().categories[RESOURCE_CATEGORIES_V1.workerInput]
          ?.reserved.bytes,
      ).toBe(INPUT_BYTES);
      input.fill(1);
    });

    const submission = scheduler.submitStaged(
      INPUT_BYTES,
      initialize,
      REVISION,
      "current",
      "active",
    );
    const request = worker.posted[0];
    if (request === undefined) throw new Error("Expected worker request");
    worker.complete(request.requestId, INPUT_BYTES);
    const result = await submission.result;

    expect(initialize).toHaveBeenCalledOnce();
    result.release();
    scheduler.dispose();
    expect(coordinator.snapshot().balanced).toBe(true);
  });

  it("releases a pre-allocation reservation when staging initialization fails", () => {
    const { coordinator, scheduler } = harness();

    expect(() =>
      scheduler.submitStaged(
        INPUT_BYTES,
        () => {
          throw new Error("initialization failed");
        },
        REVISION,
        "current",
        "active",
      ),
    ).toThrow("initialization failed");
    expect(coordinator.snapshot().balanced).toBe(true);
    scheduler.dispose();
  });
});

describe("phase-zero worker resource ownership", () => {
  it("precharges every worker state and retains completion until consumer release", async () => {
    const { coordinator, scheduler, worker } = harness();
    const input = new Uint8Array([1, BYTE_TWO, BYTE_THREE, INPUT_BYTES]);
    const submission = scheduler.submit(input, REVISION, "current", "active");
    const snapshot = coordinator.snapshot();

    expect(input.buffer.byteLength).toBe(0);
    expect(current(snapshot, RESOURCE_CATEGORIES_V1.workerOwner)).toEqual({
      bytes: WORKER_OWNER_BYTES,
      count: 1,
    });
    expect(current(snapshot, RESOURCE_CATEGORIES_V1.listener)).toEqual({
      bytes: WORKER_LISTENER_COUNT * LISTENER_BYTES,
      count: WORKER_LISTENER_COUNT,
    });
    expect(current(snapshot, RESOURCE_CATEGORIES_V1.workerInput).bytes).toBe(
      INPUT_BYTES,
    );
    expect(
      current(snapshot, RESOURCE_CATEGORIES_V1.workerQueuedJob).bytes,
    ).toBe(0);
    expect(current(snapshot, RESOURCE_CATEGORIES_V1.workerOutput).bytes).toBe(
      INPUT_BYTES,
    );
    expect(current(snapshot, RESOURCE_CATEGORIES_V1.workerScratch).bytes).toBe(
      PHASE_ZERO_CHUNK_BYTES,
    );
    expect(current(snapshot, RESOURCE_CATEGORIES_V1.workerTransfer).count).toBe(
      1,
    );
    expect(
      current(snapshot, RESOURCE_CATEGORIES_V1.workerDetachedBuffer).count,
    ).toBe(1);
    expect(current(snapshot, RESOURCE_CATEGORIES_V1.timer).count).toBe(1);
    expect(
      snapshot.categories[RESOURCE_CATEGORIES_V1.asyncContinuation],
    ).toMatchObject({
      current: { bytes: KIB, count: 1 },
      reserved: { bytes: KIB + INPUT_BYTES, count: 1 },
    });

    const request = worker.posted[0];
    if (request === undefined) throw new Error("Expected worker request");
    worker.complete(request.requestId, INPUT_BYTES);
    const result = await submission.result;
    expect(
      current(coordinator.snapshot(), RESOURCE_CATEGORIES_V1.asyncContinuation),
    ).toEqual({ bytes: KIB + INPUT_BYTES, count: 1 });
    expect(result.release()).toBe(true);
    expect(result.release()).toBe(false);
    scheduler.dispose();
    expect(coordinator.snapshot().balanced).toBe(true);
  });

  it("keeps cancellation charged until acknowledgement", async () => {
    const { coordinator, scheduler, worker } = harness();
    const submission = scheduler.submit(
      new Uint8Array([1]),
      REVISION,
      "current",
      "active",
    );

    submission.cancel();
    expect(
      current(coordinator.snapshot(), RESOURCE_CATEGORIES_V1.workerCancellation)
        .count,
    ).toBe(1);
    const cancel = worker.posted.at(worker.posted.length - 1);
    if (cancel === undefined) throw new Error("Expected cancellation request");
    worker.cancel(cancel.requestId);

    await expect(submission.result).rejects.toMatchObject({
      name: "AbortError",
    });
    scheduler.dispose();
    expect(coordinator.snapshot().balanced).toBe(true);
  });
});

describe("phase-zero worker resource handoffs", () => {
  it("keeps one payload byte charge through admission, transfer, and completion", () => {
    const coordinator = new ResourceCoordinatorV1(
      RESOURCE_BUDGET_V1.androidPhone,
    );
    const resources = WorkerTaskResources.admit(
      createWorkerResourceContext(coordinator, "handoff-test"),
      1,
      INPUT_BYTES,
    );
    if (resources === undefined) throw new Error("Expected task admission");

    expect(inputPayloadBytes(coordinator.snapshot())).toBe(INPUT_BYTES);
    expect(resources.activateExecution(true, "handoff-test")).toBe(true);
    expect(inputPayloadBytes(coordinator.snapshot())).toBe(INPUT_BYTES);
    const result = resources.publish(
      new Uint8Array(INPUT_BYTES),
      "handoff-consumer",
    );
    if (result === undefined) throw new Error("Expected owned completion");
    expect(
      resources.publish(new Uint8Array(INPUT_BYTES), "duplicate-consumer"),
    ).toBeUndefined();
    expect(resources.activateCancellation()).toBe(false);
    expect(inputPayloadBytes(coordinator.snapshot())).toBe(0);
    expect(
      current(coordinator.snapshot(), RESOURCE_CATEGORIES_V1.asyncContinuation)
        .bytes - KIB,
    ).toBe(INPUT_BYTES);

    expect(result.release()).toBe(true);
    expect(coordinator.snapshot().balanced).toBe(true);
  });

  it("reschedules an already reserved queued job after a crash", async () => {
    const { coordinator, scheduler, slices, worker } = harness();
    const { active, queued } = submitPair(scheduler);

    worker.crash();
    await expect(active.result).rejects.toBeInstanceOf(WorkerCrashedError);
    slices.flushAll();
    const result = await queued.result;
    result.release();
    scheduler.dispose();
    expect(coordinator.snapshot().balanced).toBe(true);
  });
});

describe("phase-zero worker resource failure closure", () => {
  it("rejects worker owner and task batches atomically", () => {
    const ownerDenied = coordinatorWithLimit(
      RESOURCE_CATEGORIES_V1.workerOwner,
      { count: 0 },
    );
    expect(
      WorkerOwnerResources.admit(
        createWorkerResourceContext(ownerDenied, "owner-denied"),
      ),
    ).toBeUndefined();
    expect(ownerDenied.snapshot().balanced).toBe(true);

    const listenerDenied = coordinatorWithGroupLimit(
      "listener-or-subscription",
      { count: 0 },
    );
    expect(
      WorkerOwnerResources.admit(
        createWorkerResourceContext(listenerDenied, "listener-denied"),
      ),
    ).toBeUndefined();
    expect(listenerDenied.snapshot().balanced).toBe(true);

    for (const category of [
      RESOURCE_CATEGORIES_V1.workerScratch,
      RESOURCE_CATEGORIES_V1.workerOutput,
    ]) {
      const coordinator = coordinatorWithLimit(category, { count: 0 });
      expect(
        WorkerTaskResources.admit(
          createWorkerResourceContext(coordinator, `denied-${category}`),
          1,
          1,
        ),
      ).toBeUndefined();
      expect(coordinator.snapshot().balanced).toBe(true);
    }
  });

  it("releases all charges after launch and slice scheduling failures", async () => {
    const { coordinator, scheduler, slices } = harness(
      (_worker, configuredSlices): void => {
        configuredSlices.throwOnSchedule = true;
      },
      true,
    );
    expect(slices.throwOnSchedule).toBe(true);
    const submission = scheduler.submit(
      new Uint8Array([1]),
      REVISION,
      "current",
      "active",
    );

    await expect(submission.result).rejects.toThrow("scheduling failed");
    scheduler.dispose();
    expect(coordinator.snapshot().balanced).toBe(true);
  });

  it("fails closed for transform, cancel, and malformed message failures", async () => {
    for (const failure of ["transform", "cancel", "malformed"] as const) {
      const { coordinator, scheduler, worker } = harness();
      if (failure !== "malformed") worker.throwOnKind = failure;
      const submission = scheduler.submit(
        new Uint8Array([1]),
        REVISION,
        "current",
        "active",
      );
      if (failure === "cancel") submission.cancel();
      if (failure === "malformed") {
        const request = worker.posted[0];
        if (request === undefined) throw new Error("Expected worker request");
        worker.malformed(request.requestId);
      }

      await expect(submission.result).rejects.toThrow();
      scheduler.dispose();
      expect(coordinator.snapshot().balanced).toBe(true);
    }
  });

  it("disposes active and queued reservations exactly once", async () => {
    const { coordinator, scheduler } = harness();
    const { active, queued } = submitPair(scheduler);

    scheduler.dispose();
    scheduler.dispose();

    await expect(active.result).rejects.toBeInstanceOf(WorkerDisposedError);
    await expect(queued.result).rejects.toBeInstanceOf(WorkerDisposedError);
    expect(coordinator.snapshot().balanced).toBe(true);
  });
});

function submitPair(scheduler: PhaseZeroWorkerScheduler): {
  readonly active: ReturnType<PhaseZeroWorkerScheduler["submit"]>;
  readonly queued: ReturnType<PhaseZeroWorkerScheduler["submit"]>;
} {
  return {
    active: scheduler.submit(
      new Uint8Array([1]),
      REVISION,
      "current",
      "active",
    ),
    queued: scheduler.submit(
      new Uint8Array([BYTE_TWO]),
      REVISION,
      "background",
      "idle",
    ),
  };
}

function inputPayloadBytes(
  snapshot: ReturnType<ResourceCoordinatorV1["snapshot"]>,
): number {
  return [
    RESOURCE_CATEGORIES_V1.workerQueuedJob,
    RESOURCE_CATEGORIES_V1.workerInput,
    RESOURCE_CATEGORIES_V1.workerTransfer,
    RESOURCE_CATEGORIES_V1.workerDetachedBuffer,
  ].reduce((bytes, category) => bytes + live(snapshot, category).bytes, 0);
}

function current(
  snapshot: ReturnType<ResourceCoordinatorV1["snapshot"]>,
  category: (typeof RESOURCE_CATEGORIES_V1)[keyof typeof RESOURCE_CATEGORIES_V1],
): { readonly bytes: number; readonly count: number } {
  return snapshot.categories[category]?.current ?? { bytes: 0, count: 0 };
}

function live(
  snapshot: ReturnType<ResourceCoordinatorV1["snapshot"]>,
  category: ResourceCategoryV1,
): { readonly bytes: number; readonly count: number } {
  const currentCharge = current(snapshot, category);
  const reserved = snapshot.categories[category]?.reserved ?? {
    bytes: 0,
    count: 0,
  };
  return {
    bytes: currentCharge.bytes + reserved.bytes,
    count: currentCharge.count + reserved.count,
  };
}

function coordinatorWithLimit(
  category: ResourceCategoryV1,
  limit: ResourceCategoryLimitV1,
): ResourceCoordinatorV1 {
  const base = RESOURCE_BUDGET_V1.androidPhone;
  return new ResourceCoordinatorV1({
    ...base,
    categoryLimits: { ...base.categoryLimits, [category]: limit },
  });
}

function coordinatorWithGroupLimit(
  group: string,
  limit: ResourceCategoryLimitV1,
): ResourceCoordinatorV1 {
  const base = RESOURCE_BUDGET_V1.androidPhone;
  const profile: ResourceBudgetProfileV1 = {
    ...base,
    groupLimits: { ...base.groupLimits, [group]: limit },
  };
  return new ResourceCoordinatorV1(profile);
}
