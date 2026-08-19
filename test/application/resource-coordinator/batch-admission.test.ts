import { describe, expect, it } from "vitest";

import {
  RESOURCE_BUDGET_V1,
  RESOURCE_CATEGORIES_V1,
  ResourceCoordinatorV1,
  type BatchResourceHandleV1,
  type ResourceAdmissionRequestV1,
  type ResourceAdmissionResultV1,
  type ResourceBudgetProfileV1,
  type ResourceCategoryV1,
} from "../../../src/application/resource-coordinator";

const KIB = 1_024;
const MIB = KIB * KIB;
const PHONE_WORKER_MIB = 32;
const HALF_DIVISOR = 2;
const HALF_PHONE_WORKER_MIB = PHONE_WORKER_MIB / HALF_DIVISOR;
const SMALL_CATEGORY_COUNT = 3;
const SMALL_SCOPE_COUNT = 2;
const SMALL_SCOPE_BYTES = 100;
const SMALL_STEADY_BYTES = 100;
const SMALL_TRANSIENT_BYTES = 150;
const BELOW_LIMIT_BYTES = 99;
const FIRST_PART_BYTES = 40;
const SECOND_PART_BYTES = 60;
const COMPLETION_BYTES = 25;
const EMERGENCY_KIB = 64;

describe("ResourceCoordinatorV1 batch group admission", () => {
  it("admits mixed worker categories exactly at the shared group limit", () => {
    const coordinator = new ResourceCoordinatorV1(
      RESOURCE_BUDGET_V1.androidPhone,
    );
    const handle = admitted(
      coordinator.admitBatch({
        operations: [
          operation(
            RESOURCE_CATEGORIES_V1.workerInput,
            HALF_PHONE_WORKER_MIB * MIB,
          ),
          operation(
            RESOURCE_CATEGORIES_V1.workerOutput,
            HALF_PHONE_WORKER_MIB * MIB,
          ),
        ],
      }),
    );
    const beforeTransfer = coordinator.snapshot();

    expect(handle.transfer("worker-owner")).toBe(true);
    expect(coordinator.snapshot()).toEqual(beforeTransfer);
    expect(handle.activate()).toBe(true);
    expect(handle.state).toBe("active");
    expect(handle.release()).toBe(true);
    expect(handle.release()).toBe(false);
    expect(coordinator.snapshot().balanced).toBe(true);
  });

  it("rejects one byte above a mixed group limit without partial reservation", () => {
    const coordinator = new ResourceCoordinatorV1(
      RESOURCE_BUDGET_V1.androidPhone,
    );

    expect(
      coordinator.admitBatch({
        operations: [
          operation(
            RESOURCE_CATEGORIES_V1.workerInput,
            HALF_PHONE_WORKER_MIB * MIB,
          ),
          operation(
            RESOURCE_CATEGORIES_V1.workerOutput,
            HALF_PHONE_WORKER_MIB * MIB,
          ),
          operation(RESOURCE_CATEGORIES_V1.workerScratch, 1),
        ],
      }),
    ).toEqual({ kind: "rejected", reason: "group-byte-limit" });
    expect(coordinator.snapshot()).toMatchObject({
      balanced: true,
      current: { bytes: 0, count: 0 },
      reserved: { bytes: 0, count: 0 },
    });
  });
});

describe("ResourceCoordinatorV1 batch conjunctive limits", () => {
  it("admits below and at mixed global limits, then rejects above", () => {
    const below = new ResourceCoordinatorV1(smallProfile());
    const belowHandle = admitted(
      below.admitBatch({
        operations: [
          operation(RESOURCE_CATEGORIES_V1.workerInput, BELOW_LIMIT_BYTES),
        ],
      }),
    );
    belowHandle.release();

    const at = new ResourceCoordinatorV1(smallProfile());
    const atHandle = admitted(
      at.admitBatch({
        operations: [
          operation(RESOURCE_CATEGORIES_V1.workerInput, FIRST_PART_BYTES),
          operation(RESOURCE_CATEGORIES_V1.recoveryRecord, SECOND_PART_BYTES),
        ],
      }),
    );
    atHandle.release();

    const above = new ResourceCoordinatorV1(smallProfile());
    expect(
      above.admitBatch({
        operations: [
          operation(RESOURCE_CATEGORIES_V1.workerInput, FIRST_PART_BYTES),
          operation(RESOURCE_CATEGORIES_V1.recoveryRecord, SECOND_PART_BYTES),
          operation(RESOURCE_CATEGORIES_V1.workerOutput, 1),
        ],
      }),
    ).toEqual({ kind: "rejected", reason: "steady-byte-limit" });
    expect(above.snapshot().balanced).toBe(true);
  });

  it("enforces mixed category and scope limits atomically", () => {
    const categoryCoordinator = new ResourceCoordinatorV1(smallProfile());
    expect(
      categoryCoordinator.admitBatch({
        operations: [
          operation(
            RESOURCE_CATEGORIES_V1.workerInput,
            0,
            SMALL_CATEGORY_COUNT,
          ),
          operation(RESOURCE_CATEGORIES_V1.workerInput, 0),
        ],
      }),
    ).toEqual({ kind: "rejected", reason: "category-count-limit" });
    expect(categoryCoordinator.snapshot().balanced).toBe(true);

    const scopeCoordinator = new ResourceCoordinatorV1(smallProfile());
    const scoped = admitted(
      scopeCoordinator.admitBatch({
        operations: [
          scopedOperation(FIRST_PART_BYTES),
          scopedOperation(SECOND_PART_BYTES),
        ],
      }),
    );
    scoped.release();
    expect(
      scopeCoordinator.admitBatch({
        operations: [
          scopedOperation(FIRST_PART_BYTES),
          scopedOperation(SECOND_PART_BYTES),
          scopedOperation(0),
        ],
      }),
    ).toEqual({ kind: "rejected", reason: "scope-count-limit" });
    expect(scopeCoordinator.snapshot().balanced).toBe(true);
  });
});

describe("ResourceCoordinatorV1 batch completion and misuse", () => {
  it("precharges one completion and settles all operation categories together", () => {
    const coordinator = new ResourceCoordinatorV1(smallProfile());
    const handle = admitted(
      coordinator.admitBatch({
        completionBytes: COMPLETION_BYTES,
        operations: [
          scopedOperation(FIRST_PART_BYTES),
          operation(RESOURCE_CATEGORIES_V1.recoveryRecord, SECOND_PART_BYTES),
        ],
      }),
    );

    expect(coordinator.snapshot().reserved).toEqual({
      bytes: SMALL_STEADY_BYTES + COMPLETION_BYTES,
      count: SMALL_SCOPE_COUNT + 1,
    });
    expect(handle.publishCompletion()).toBe(false);
    expect(handle.activate()).toBe(true);
    expect(handle.transfer("completion-owner")).toBe(true);
    expect(handle.publishCompletion()).toBe(true);
    expect(handle.state).toBe("completion");
    expect(handle.release()).toBe(true);
    expect(coordinator.snapshot().balanced).toBe(true);
  });

  it("rejects empty, malformed, and disposed batches without retained charges", () => {
    const coordinator = new ResourceCoordinatorV1(smallProfile());
    expect(coordinator.admitBatch({ operations: [] })).toEqual({
      kind: "rejected",
      reason: "invalid-request",
    });
    expect(
      coordinator.admitBatch({
        operations: [
          operation(RESOURCE_CATEGORIES_V1.workerInput, FIRST_PART_BYTES),
          operation(RESOURCE_CATEGORIES_V1.recoveryRecord, Number.NaN),
        ],
      }),
    ).toEqual({ kind: "rejected", reason: "invalid-request" });
    expect(coordinator.snapshot().balanced).toBe(true);

    coordinator.dispose();
    expect(
      coordinator.admitBatch({
        operations: [
          operation(RESOURCE_CATEGORIES_V1.workerInput, FIRST_PART_BYTES),
        ],
      }),
    ).toEqual({ kind: "rejected", reason: "disposed" });
    expect(coordinator.snapshot().balanced).toBe(true);
  });
});

function smallProfile(): ResourceBudgetProfileV1 {
  return {
    categoryLimits: {
      [RESOURCE_CATEGORIES_V1.asyncContinuation]: { count: 1 },
      [RESOURCE_CATEGORIES_V1.recoveryRecord]: {
        count: SMALL_CATEGORY_COUNT,
      },
      [RESOURCE_CATEGORIES_V1.sessionTurn]: {
        perScopeBytes: SMALL_SCOPE_BYTES,
        perScopeCount: SMALL_SCOPE_COUNT,
      },
      [RESOURCE_CATEGORIES_V1.workerInput]: {
        count: SMALL_CATEGORY_COUNT,
      },
      [RESOURCE_CATEGORIES_V1.workerOutput]: {
        count: SMALL_CATEGORY_COUNT,
      },
    },
    emergencyPayloadBytes: EMERGENCY_KIB * KIB,
    groupLimits: {},
    platform: "desktop-or-android-tablet",
    steadyResidentBytes: SMALL_STEADY_BYTES,
    transientResidentBytes: SMALL_TRANSIENT_BYTES,
  };
}

function operation(
  category: ResourceCategoryV1,
  bytes: number,
  count = 1,
): ResourceAdmissionRequestV1 {
  return {
    bytes,
    category,
    count,
    ownerId: "batch-owner",
    residency: "steady",
  };
}

function scopedOperation(bytes: number): ResourceAdmissionRequestV1 {
  return {
    ...operation(RESOURCE_CATEGORIES_V1.sessionTurn, bytes),
    scope: { id: "session-a", kind: "session" },
  };
}

function admitted(
  result: ResourceAdmissionResultV1<BatchResourceHandleV1>,
): BatchResourceHandleV1 {
  expect(result.kind).toBe("admitted");
  if (result.kind !== "admitted") throw new Error("Expected batch admission");
  return result.handle;
}
