import { describe, expect, it } from "vitest";

import {
  RESOURCE_BUDGET_V1,
  RESOURCE_CATEGORIES_V1,
  ResourceCoordinatorV1,
  type ResourceAdmissionHandleV1,
  type ResourceAdmissionRequestV1,
  type ResourceAdmissionResultV1,
  type ResourceCategoryV1,
} from "../../../src/application/resource-coordinator";

const KIB = 1_024;
const MIB = KIB * KIB;
const BASE_CHARGE = 512;
const DOM_LIMIT = 4_000;
const VIEW_LISTENER_LIMIT = 128;
const PLUGIN_LISTENER_LIMIT = 256;
const PHONE_WORKER_MIB = 32;
const PHONE_WORKER_COUNT = 2;
const OBSERVER_KIB = 2;
const FRAMEWORK_ROOT_KIB = 64;
const WORKER_OWNER_KIB = 16;
const WORKER_SEGMENT_MIB = 16;
const WORKER_QUEUE_LIMIT = 64;
const WORKER_QUEUE_MIB = 16;
const HISTORY_MIB = 32;
const VIEW_LIFECYCLE_LIMIT = 32;
const RECOVERY_LIMIT = 4_096;
const INDEXED_DB_TURN_LIMIT = 2;
const READING_PHONE_LIMIT = 512;

describe("RESOURCE_CHARGE_V1 lifecycle limits", () => {
  it("adds base bytes and enforces the exact per-view DOM limit", () => {
    const coordinator = phoneCoordinator();
    const atLimit = admit(
      coordinator,
      RESOURCE_CATEGORIES_V1.domNode,
      DOM_LIMIT,
      1,
      "view-a",
    );

    expect(atLimit.bytes).toBe(DOM_LIMIT * BASE_CHARGE + 1);
    expect(
      coordinator.admit(
        request(RESOURCE_CATEGORIES_V1.domNode, 1, 0, "view-a"),
      ),
    ).toEqual({ kind: "rejected", reason: "scope-count-limit" });
    atLimit.release();
    expect(coordinator.snapshot().balanced).toBe(true);
  });

  it("enforces listener and subscription as one per-view and plugin group", () => {
    const coordinator = phoneCoordinator();
    const viewA = admit(
      coordinator,
      RESOURCE_CATEGORIES_V1.listener,
      VIEW_LISTENER_LIMIT,
      0,
      "view-a",
    );
    expect(
      coordinator.admit(
        request(RESOURCE_CATEGORIES_V1.subscription, 1, 0, "view-a"),
      ),
    ).toEqual({ kind: "rejected", reason: "group-count-limit" });
    const viewB = admit(
      coordinator,
      RESOURCE_CATEGORIES_V1.subscription,
      PLUGIN_LISTENER_LIMIT - VIEW_LISTENER_LIMIT,
      0,
      "view-b",
    );
    expect(
      coordinator.admit(
        request(RESOURCE_CATEGORIES_V1.listener, 1, 0, "view-c"),
      ),
    ).toEqual({ kind: "rejected", reason: "group-count-limit" });
    viewA.release();
    viewB.release();
  });

  it("applies observer and Reading View profile charges and counts", () => {
    const profile = RESOURCE_BUDGET_V1.androidPhone;
    expect(
      profile.categoryLimits[RESOURCE_CATEGORIES_V1.observer],
    ).toMatchObject({
      baseBytes: OBSERVER_KIB * KIB,
      perScopeCount: VIEW_LIFECYCLE_LIMIT,
    });
    expect(
      profile.categoryLimits[RESOURCE_CATEGORIES_V1.readingViewObserver],
    ).toMatchObject({
      baseBytes: OBSERVER_KIB * KIB,
      perScopeCount: READING_PHONE_LIMIT,
    });
    expect(
      profile.categoryLimits[RESOURCE_CATEGORIES_V1.frameworkRoot]?.baseBytes,
    ).toBe(FRAMEWORK_ROOT_KIB * KIB);
  });
});

describe("RESOURCE_BUDGET_V1 worker subledger", () => {
  it("combines input, output, scratch, transfers, and detached ownership", () => {
    const coordinator = phoneCoordinator();
    const input = admit(
      coordinator,
      RESOURCE_CATEGORIES_V1.workerInput,
      1,
      WORKER_SEGMENT_MIB * MIB,
    );
    const output = admit(
      coordinator,
      RESOURCE_CATEGORIES_V1.workerOutput,
      1,
      WORKER_SEGMENT_MIB * MIB,
    );

    for (const category of [
      RESOURCE_CATEGORIES_V1.workerScratch,
      RESOURCE_CATEGORIES_V1.workerTransfer,
      RESOURCE_CATEGORIES_V1.workerDetachedBuffer,
      RESOURCE_CATEGORIES_V1.workerCancellation,
    ]) {
      expect(coordinator.admit(request(category, 1, 1))).toEqual({
        kind: "rejected",
        reason: "group-byte-limit",
      });
    }
    input.release();
    output.release();
  });

  it("enforces worker owner count, owner base charge, and queue bounds", () => {
    const coordinator = phoneCoordinator();
    const owners = admit(
      coordinator,
      RESOURCE_CATEGORIES_V1.workerOwner,
      PHONE_WORKER_COUNT,
      0,
    );
    expect(owners.bytes).toBe(PHONE_WORKER_COUNT * WORKER_OWNER_KIB * KIB);
    expect(
      coordinator.admit(request(RESOURCE_CATEGORIES_V1.workerOwner, 1, 0)),
    ).toEqual({ kind: "rejected", reason: "category-count-limit" });
    owners.release();

    const queued = admit(
      coordinator,
      RESOURCE_CATEGORIES_V1.workerQueuedJob,
      WORKER_QUEUE_LIMIT,
      WORKER_QUEUE_MIB * MIB,
    );
    expect(
      coordinator.admit(request(RESOURCE_CATEGORIES_V1.workerQueuedJob, 1, 0)),
    ).toEqual({ kind: "rejected", reason: "category-count-limit" });
    queued.release();
  });

  it("publishes the phone worker group boundary", () => {
    expect(
      RESOURCE_BUDGET_V1.androidPhone.groupLimits["worker-resident"]?.bytes,
    ).toBe(PHONE_WORKER_MIB * MIB);
  });
});

describe("RESOURCE_BUDGET_V1 history and recovery limits", () => {
  it("enforces history bytes per view and recovery records plugin-wide", () => {
    const coordinator = phoneCoordinator();
    const history = admit(
      coordinator,
      RESOURCE_CATEGORIES_V1.hostHistoryRecord,
      1,
      HISTORY_MIB * MIB,
      "view-a",
    );
    expect(
      coordinator.admit(
        request(RESOURCE_CATEGORIES_V1.hostHistoryRecord, 1, 1, "view-a"),
      ),
    ).toEqual({ kind: "rejected", reason: "scope-byte-limit" });
    history.release();

    const recovery = admit(
      coordinator,
      RESOURCE_CATEGORIES_V1.recoveryRecord,
      RECOVERY_LIMIT,
      0,
    );
    expect(
      coordinator.admit(request(RESOURCE_CATEGORIES_V1.recoveryRecord, 1, 0)),
    ).toEqual({ kind: "rejected", reason: "category-count-limit" });
    recovery.release();
  });

  it("enforces one active plus one latest IndexedDB turn per session", () => {
    const coordinator = phoneCoordinator();
    const queued = admit(
      coordinator,
      RESOURCE_CATEGORIES_V1.indexedDbQueueTurn,
      INDEXED_DB_TURN_LIMIT,
      0,
      "session-a",
      "session",
    );
    expect(
      coordinator.admit(
        request(
          RESOURCE_CATEGORIES_V1.indexedDbQueueTurn,
          1,
          0,
          "session-a",
          "session",
        ),
      ),
    ).toEqual({ kind: "rejected", reason: "scope-count-limit" });
    queued.release();
  });
});

function phoneCoordinator(): ResourceCoordinatorV1 {
  return new ResourceCoordinatorV1(RESOURCE_BUDGET_V1.androidPhone);
}

function request(
  category: ResourceCategoryV1,
  count: number,
  bytes: number,
  scopeId?: string,
  scopeKind: "session" | "view" = "view",
): ResourceAdmissionRequestV1 {
  return {
    bytes,
    category,
    count,
    ownerId: "test-owner",
    residency: "steady" as const,
    ...(scopeId === undefined
      ? {}
      : { scope: { id: scopeId, kind: scopeKind } }),
  };
}

function admit(
  coordinator: ResourceCoordinatorV1,
  category: ResourceCategoryV1,
  count: number,
  bytes: number,
  scopeId?: string,
  scopeKind: "session" | "view" = "view",
): ResourceAdmissionHandleV1 {
  const result: ResourceAdmissionResultV1 = coordinator.admit(
    request(category, count, bytes, scopeId, scopeKind),
  );
  expect(result.kind).toBe("admitted");
  if (result.kind !== "admitted") throw new Error("Expected admission");
  return result.handle;
}
