import { describe, expect, it } from "vitest";

import {
  RESOURCE_BUDGET_V1,
  RESOURCE_CATEGORIES_V1,
  ResourceCoordinatorV1,
} from "../../../src/application/resource-coordinator";
import {
  PhaseZeroWorkerScheduler,
  WorkerQueueExhaustedError,
  type PhaseZeroRevision,
  type PhaseZeroSliceScheduler,
} from "../../../src/workers/phase-zero";

const REVISION: PhaseZeroRevision = { layout: 3, scene: 2 };
const KIB = 1_024;
const MIB = KIB * KIB;
const MAX_WORKER_JOBS = 64;
const MAX_WORKER_QUEUE_MIB = 16;
const MAX_WORKER_QUEUE_BYTES = MAX_WORKER_QUEUE_MIB * MIB;

function boundaryHarness(): {
  readonly coordinator: ResourceCoordinatorV1;
  readonly scheduler: PhaseZeroWorkerScheduler;
} {
  const coordinator = new ResourceCoordinatorV1(
    RESOURCE_BUDGET_V1.desktopOrAndroidTablet,
  );
  const slices: PhaseZeroSliceScheduler = {
    schedule: (): (() => void) => () => undefined,
  };
  const scheduler = new PhaseZeroWorkerScheduler({
    clock: { now: (): number => 0 },
    isCurrent: (): boolean => true,
    launchWorker: (): undefined => undefined,
    maxOutstandingBytes: MAX_WORKER_QUEUE_BYTES,
    maxOutstandingRequests: MAX_WORKER_JOBS,
    resourceCoordinator: coordinator,
    resourceOwnerId: "worker-boundary-test",
    slices,
  });
  return { coordinator, scheduler };
}

describe("phase-zero worker resource boundaries", () => {
  it("holds the 64-job profile boundary alongside scheduler limits", () => {
    const { coordinator, scheduler } = boundaryHarness();
    const submissions = Array.from({ length: MAX_WORKER_JOBS }, (_, index) =>
      scheduler.submit(new Uint8Array(), REVISION, "background", "idle", {
        id: `session-${String(index)}`,
        kind: "session",
      }),
    );
    for (const submission of submissions)
      void submission.result.catch(() => undefined);

    const queued =
      coordinator.snapshot().categories[RESOURCE_CATEGORIES_V1.workerQueuedJob];
    expect((queued?.current.count ?? 0) + (queued?.reserved.count ?? 0)).toBe(
      MAX_WORKER_JOBS,
    );
    expect(() =>
      scheduler.submit(new Uint8Array(), REVISION, "background", "idle"),
    ).toThrow(WorkerQueueExhaustedError);
    scheduler.dispose();
    expect(coordinator.snapshot().balanced).toBe(true);
  });

  it("applies the 16 MiB queue ceiling conjunctively with residency", () => {
    const { coordinator, scheduler } = boundaryHarness();
    const submissions = Array.from(
      { length: MAX_WORKER_QUEUE_MIB },
      (_, index) =>
        scheduler.submit(new Uint8Array(MIB), REVISION, "background", "idle", {
          id: `large-session-${String(index)}`,
          kind: "session",
        }),
    );
    for (const submission of submissions)
      void submission.result.catch(() => undefined);

    expect(() =>
      scheduler.submit(new Uint8Array(MIB), REVISION, "background", "idle"),
    ).toThrow(WorkerQueueExhaustedError);
    scheduler.dispose();
    expect(coordinator.snapshot().balanced).toBe(true);
  });
});
