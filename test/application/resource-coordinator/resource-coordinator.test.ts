import { describe, expect, it } from "vitest";

import {
  RESOURCE_BUDGET_V1,
  RESOURCE_CATEGORIES_V1,
  ResourceCoordinatorV1,
  type AsyncResourceHandleV1,
  type ResourceAdmissionHandleV1,
  type ResourceAdmissionRequestV1,
  type ResourceAdmissionResultV1,
  type ResourceBudgetProfileV1,
  type ResourceCategoryV1,
  type SessionResourceHandleV1,
} from "../../../src/application/resource-coordinator";

const KIB = 1_024;
const MIB = KIB * KIB;
const EMERGENCY_KIB = 64;
const EMERGENCY_BYTES = EMERGENCY_KIB * KIB;
const SMALL_BYTE_LIMIT = 100;
const SMALL_COUNT_LIMIT = 2;
const EMERGENCY_SLOT_COUNT = 2;
const TRANSIENT_HEADROOM = 150;
const SMALL_TRANSIENT_LIMIT =
  EMERGENCY_SLOT_COUNT * EMERGENCY_BYTES + TRANSIENT_HEADROOM;
const DESKTOP_SESSION_LIMIT = 16;
const PHONE_SESSION_LIMIT = 8;
const FIRST_BYTES = 40;
const SECOND_BYTES = 60;
const HALF_LIMIT_BYTES = 50;
const ABOVE_STEADY_BYTES = SMALL_BYTE_LIMIT + 1;
const DESKTOP_WORKER_MIB = 48;
const PHONE_PERSISTENCE_MIB = 64;

describe("ResourceCoordinatorV1 admission", () => {
  it("tracks reservation, activation, high water, suspension, and exact release", () => {
    const coordinator = new ResourceCoordinatorV1(smallProfile());
    const first = admitted(
      coordinator.admit(
        request(RESOURCE_CATEGORIES_V1.workerInput, "owner-a", FIRST_BYTES),
      ),
    );
    const second = admitted(
      coordinator.admit(
        request(RESOURCE_CATEGORIES_V1.workerInput, "owner-b", SECOND_BYTES),
      ),
    );

    expect(first.activate()).toBe(true);
    expect(first.activate()).toBe(false);
    expect(
      coordinator.admit(
        request(RESOURCE_CATEGORIES_V1.workerInput, "owner-c", 1),
      ),
    ).toEqual({
      kind: "rejected",
      reason: "category-count-limit",
    });
    expect(
      coordinator.admit({
        ...request(RESOURCE_CATEGORIES_V1.workerInput, "owner-c", 1),
        disposition: "suspend",
      }),
    ).toEqual({ kind: "suspended", reason: "category-count-limit" });

    expect(
      coordinator.snapshot().categories[RESOURCE_CATEGORIES_V1.workerInput],
    ).toEqual({
      current: { bytes: FIRST_BYTES, count: 1 },
      highWater: { bytes: SMALL_BYTE_LIMIT, count: SMALL_COUNT_LIMIT },
      rejected: { bytes: 1, count: 1 },
      released: { bytes: 0, count: 0 },
      reserved: { bytes: SECOND_BYTES, count: 1 },
      suspended: { bytes: 1, count: 1 },
    });
    expect(coordinator.snapshot()).toMatchObject({
      rejected: { bytes: 1, count: 1 },
      suspended: { bytes: 1, count: 1 },
    });
    expect(first.release()).toBe(true);
    expect(first.release()).toBe(false);
    expect(second.release()).toBe(true);
    expect(coordinator.snapshot()).toMatchObject({
      balanced: true,
      current: { bytes: 0, count: 0 },
      reserved: { bytes: 0, count: 0 },
    });
    expect(
      coordinator.snapshot().categories[RESOURCE_CATEGORIES_V1.workerInput]
        ?.released,
    ).toEqual({
      bytes: SMALL_BYTE_LIMIT,
      count: SMALL_COUNT_LIMIT,
    });
    expect(coordinator.snapshot().released).toEqual({
      bytes: SMALL_BYTE_LIMIT,
      count: SMALL_COUNT_LIMIT,
    });
  });
});

describe("ResourceCoordinatorV1 limit boundaries", () => {
  it("enforces count, byte, scope, steady, and transient limits before allocation", () => {
    const countCoordinator = new ResourceCoordinatorV1(smallProfile());
    const atCount = admitted(
      countCoordinator.admit({
        ...request(
          RESOURCE_CATEGORIES_V1.workerInput,
          "at-count",
          SMALL_BYTE_LIMIT,
        ),
        count: SMALL_COUNT_LIMIT,
      }),
    );
    expect(
      countCoordinator.admit(
        request(RESOURCE_CATEGORIES_V1.workerInput, "above-count", 0),
      ),
    ).toEqual({ kind: "rejected", reason: "category-count-limit" });
    atCount.release();

    const byteCoordinator = new ResourceCoordinatorV1(smallProfile());
    const atBytes = admitted(
      byteCoordinator.admit(
        request(
          RESOURCE_CATEGORIES_V1.workerInput,
          "at-bytes",
          SMALL_BYTE_LIMIT,
        ),
      ),
    );
    expect(
      byteCoordinator.admit(
        request(RESOURCE_CATEGORIES_V1.workerInput, "above-bytes", 1),
      ),
    ).toEqual({ kind: "rejected", reason: "category-byte-limit" });
    atBytes.release();

    const scopeCoordinator = new ResourceCoordinatorV1(smallProfile());
    const scoped = admitted(
      scopeCoordinator.admit(
        scopedRequest(
          RESOURCE_CATEGORIES_V1.sessionTurn,
          "first",
          "session-a",
          HALF_LIMIT_BYTES,
        ),
      ),
    );
    expect(
      scopeCoordinator.admit(
        scopedRequest(
          RESOURCE_CATEGORIES_V1.sessionTurn,
          "second",
          "session-a",
          1,
        ),
      ),
    ).toEqual({ kind: "rejected", reason: "scope-count-limit" });
    expect(
      scopeCoordinator.admit(
        scopedRequest(
          RESOURCE_CATEGORIES_V1.sessionTurn,
          "other",
          "session-b",
          HALF_LIMIT_BYTES,
        ),
      ),
    ).toMatchObject({ kind: "admitted" });
    scoped.release();

    const steadyCoordinator = new ResourceCoordinatorV1(smallProfile());
    expect(
      steadyCoordinator.admit(
        request(
          RESOURCE_CATEGORIES_V1.recoveryRecord,
          "steady",
          ABOVE_STEADY_BYTES,
        ),
      ),
    ).toEqual({ kind: "rejected", reason: "steady-byte-limit" });
    expect(
      steadyCoordinator.admit({
        ...request(
          RESOURCE_CATEGORIES_V1.recoveryRecord,
          "transient",
          SMALL_TRANSIENT_LIMIT + 1,
        ),
        residency: "transient",
      }),
    ).toEqual({ kind: "rejected", reason: "transient-byte-limit" });
  });
});

describe("ResourceCoordinatorV1 transfer", () => {
  it("changes ownership without changing charges and rejects handle misuse", () => {
    const coordinator = new ResourceCoordinatorV1(smallProfile());
    const handle = admitted(
      coordinator.admit(
        request(RESOURCE_CATEGORIES_V1.workerInput, "sender", HALF_LIMIT_BYTES),
      ),
    );
    const before = coordinator.snapshot();

    expect(handle.transfer("receiver")).toBe(true);
    expect(handle.ownerId).toBe("receiver");
    expect(handle.transfer(" ")).toBe(false);
    expect(coordinator.snapshot()).toEqual(before);
    expect(handle.release()).toBe(true);
    expect(handle.transfer("late-owner")).toBe(false);
    expect(handle.activate()).toBe(false);
  });
});

describe("ResourceCoordinatorV1 asynchronous completion", () => {
  it("atomically precharges completion capacity until terminal settlement", () => {
    const coordinator = new ResourceCoordinatorV1(smallProfile());
    const first = admittedAsync(
      coordinator.admitAsync({
        completionBytes: 25,
        operation: scopedRequest(
          RESOURCE_CATEGORIES_V1.workerOutput,
          "worker-a",
          "session-a",
          HALF_LIMIT_BYTES,
        ),
      }),
    );

    expect(
      coordinator.admitAsync({
        completionBytes: 1,
        operation: scopedRequest(
          RESOURCE_CATEGORIES_V1.workerOutput,
          "worker-b",
          "session-a",
          1,
        ),
      }),
    ).toEqual({ kind: "rejected", reason: "category-count-limit" });
    expect(
      coordinator.snapshot().categories[RESOURCE_CATEGORIES_V1.workerOutput]
        ?.reserved,
    ).toEqual({ bytes: HALF_LIMIT_BYTES, count: 1 });
    expect(
      coordinator.snapshot().categories[
        RESOURCE_CATEGORIES_V1.asyncContinuation
      ]?.reserved,
    ).toEqual({ bytes: 25, count: 1 });

    expect(first.publishCompletion()).toBe(false);
    expect(first.activate()).toBe(true);
    expect(first.transfer("worker-thread")).toBe(true);
    expect(first.publishCompletion("session-queue")).toBe(true);
    expect(first.state).toBe("completion");
    expect(first.publishCompletion()).toBe(false);
    expect(first.release()).toBe(true);
    expect(first.release()).toBe(false);
    expect(coordinator.snapshot().balanced).toBe(true);
  });

  it("admits exactly one competitor when completion capacity has one slot", async () => {
    const coordinator = new ResourceCoordinatorV1(smallProfile());
    const results = await Promise.all(
      ["first", "second"].map(async (ownerId) =>
        coordinator.admitAsync({
          completionBytes: 1,
          operation: scopedRequest(
            RESOURCE_CATEGORIES_V1.workerOutput,
            ownerId,
            "session-a",
            1,
          ),
        }),
      ),
    );

    expect(results.filter(({ kind }) => kind === "admitted")).toHaveLength(1);
    expect(results.filter(({ kind }) => kind === "rejected")).toHaveLength(1);
    for (const result of results) {
      if (result.kind === "admitted") result.handle.release();
    }
    expect(coordinator.snapshot().balanced).toBe(true);
  });
});

describe("ResourceCoordinatorV1 session capacity", () => {
  it("keeps lifecycle and host-history emergency slots available at ordinary saturation", () => {
    const coordinator = new ResourceCoordinatorV1(smallProfile());
    const session = admittedSession(coordinator.admitSession("session-a", 1));
    const ordinary = admitted(
      coordinator.admit(
        scopedRequest(
          RESOURCE_CATEGORIES_V1.sessionTurn,
          "ordinary",
          "session-a",
          HALF_LIMIT_BYTES,
        ),
      ),
    );
    expect(
      coordinator.admit(
        scopedRequest(
          RESOURCE_CATEGORIES_V1.sessionTurn,
          "overflow",
          "session-a",
          1,
        ),
      ),
    ).toEqual({ kind: "rejected", reason: "scope-count-limit" });

    const lifecycle = session.admitEmergency("lifecycle", EMERGENCY_BYTES);
    const history = session.admitEmergency("host-history", EMERGENCY_BYTES);
    expect(lifecycle.kind).toBe("admitted");
    expect(history.kind).toBe("admitted");
    expect(session.admitEmergency("lifecycle", 1)).toEqual({
      kind: "rejected",
      reason: "emergency-slot-busy",
    });
    expect(session.admitEmergency("host-history", EMERGENCY_BYTES + 1)).toEqual(
      {
        kind: "rejected",
        reason: "emergency-payload-limit",
      },
    );

    if (lifecycle.kind === "admitted") lifecycle.handle.release();
    const resumed = session.admitEmergency("lifecycle", 1);
    expect(resumed.kind).toBe("admitted");
    ordinary.release();
    expect(session.release()).toBe(true);
    if (resumed.kind === "admitted") expect(resumed.handle.released).toBe(true);
    if (history.kind === "admitted") expect(history.handle.released).toBe(true);
    expect(session.release()).toBe(false);
    expect(coordinator.snapshot().balanced).toBe(true);
  });

  it("uses the exact desktop, tablet, and phone session profiles", () => {
    verifySessionLimit(
      RESOURCE_BUDGET_V1.desktopOrAndroidTablet,
      DESKTOP_SESSION_LIMIT,
    );
    verifySessionLimit(RESOURCE_BUDGET_V1.androidPhone, PHONE_SESSION_LIMIT);
    expect(
      RESOURCE_BUDGET_V1.desktopOrAndroidTablet.categoryLimits[
        RESOURCE_CATEGORIES_V1.workerResident
      ]?.bytes,
    ).toBe(DESKTOP_WORKER_MIB * MIB);
    expect(
      RESOURCE_BUDGET_V1.androidPhone.categoryLimits[
        RESOURCE_CATEGORIES_V1.persistencePipeline
      ],
    ).toMatchObject({ bytes: PHONE_PERSISTENCE_MIB * MIB, count: 1 });
  });
});

describe("ResourceCoordinatorV1 disposal and malformed input", () => {
  it("releases reserved and current handles once and rejects work after disposal", () => {
    const coordinator = new ResourceCoordinatorV1(smallProfile());
    const reserved = admitted(
      coordinator.admit(
        request(RESOURCE_CATEGORIES_V1.workerInput, "reserved", FIRST_BYTES),
      ),
    );
    const current = admitted(
      coordinator.admit(
        request(RESOURCE_CATEGORIES_V1.workerInput, "current", SECOND_BYTES),
      ),
    );
    current.activate();

    expect(coordinator.dispose()).toBe(true);
    expect(coordinator.dispose()).toBe(false);
    expect(coordinator.snapshot()).toMatchObject({
      balanced: true,
      disposed: true,
    });
    expect(reserved.release()).toBe(false);
    expect(current.release()).toBe(false);
    expect(
      coordinator.admit(request(RESOURCE_CATEGORIES_V1.workerInput, "late", 1)),
    ).toEqual({
      kind: "rejected",
      reason: "disposed",
    });
  });

  it("rejects malformed charges without corrupting ledger counters", () => {
    const coordinator = new ResourceCoordinatorV1(smallProfile());
    const malformed = {
      ...request(RESOURCE_CATEGORIES_V1.workerInput, "owner", 1),
      bytes: Number.NaN,
    };

    expect(coordinator.admit(malformed)).toEqual({
      kind: "rejected",
      reason: "invalid-request",
    });
    expect(coordinator.snapshot()).toMatchObject({
      balanced: true,
      current: { bytes: 0, count: 0 },
      reserved: { bytes: 0, count: 0 },
    });
  });
});

function smallProfile(): ResourceBudgetProfileV1 {
  return {
    categoryLimits: {
      [RESOURCE_CATEGORIES_V1.workerInput]: {
        bytes: SMALL_BYTE_LIMIT,
        count: SMALL_COUNT_LIMIT,
      },
      [RESOURCE_CATEGORIES_V1.asyncContinuation]: {
        count: 1,
        perScopeCount: 1,
      },
      [RESOURCE_CATEGORIES_V1.hostHistoryEmergency]: {
        bytes: EMERGENCY_BYTES,
        count: 1,
        perScopeBytes: EMERGENCY_BYTES,
        perScopeCount: 1,
      },
      [RESOURCE_CATEGORIES_V1.lifecycleEmergency]: {
        bytes: EMERGENCY_BYTES,
        count: 1,
        perScopeBytes: EMERGENCY_BYTES,
        perScopeCount: 1,
      },
      [RESOURCE_CATEGORIES_V1.noteSession]: { count: 1, perScopeCount: 1 },
      [RESOURCE_CATEGORIES_V1.sessionTurn]: {
        bytes: SMALL_BYTE_LIMIT,
        count: SMALL_COUNT_LIMIT,
        perScopeBytes: 50,
        perScopeCount: 1,
      },
      [RESOURCE_CATEGORIES_V1.workerOutput]: {
        bytes: SMALL_BYTE_LIMIT,
        count: SMALL_COUNT_LIMIT,
      },
    },
    emergencyPayloadBytes: EMERGENCY_BYTES,
    groupLimits: {},
    platform: "desktop-or-android-tablet",
    steadyResidentBytes: SMALL_BYTE_LIMIT,
    transientResidentBytes: SMALL_TRANSIENT_LIMIT,
  };
}

function request(
  category: ResourceCategoryV1,
  ownerId: string,
  bytes: number,
): ResourceAdmissionRequestV1 {
  return { bytes, category, count: 1, ownerId, residency: "steady" };
}

function scopedRequest(
  category: ResourceCategoryV1,
  ownerId: string,
  sessionId: string,
  bytes: number,
): ResourceAdmissionRequestV1 {
  return {
    ...request(category, ownerId, bytes),
    scope: { id: sessionId, kind: "session" },
  };
}

function admitted(
  result: ResourceAdmissionResultV1,
): ResourceAdmissionHandleV1 {
  expect(result.kind).toBe("admitted");
  if (result.kind !== "admitted") throw new Error("Expected admission");
  return result.handle;
}

function admittedAsync(
  result: ResourceAdmissionResultV1<AsyncResourceHandleV1>,
): AsyncResourceHandleV1 {
  expect(result.kind).toBe("admitted");
  if (result.kind !== "admitted") throw new Error("Expected async admission");
  return result.handle;
}

function admittedSession(
  result: ResourceAdmissionResultV1<SessionResourceHandleV1>,
): SessionResourceHandleV1 {
  expect(result.kind).toBe("admitted");
  if (result.kind !== "admitted") throw new Error("Expected session admission");
  return result.handle;
}

function verifySessionLimit(
  profile: ResourceBudgetProfileV1,
  limit: number,
): void {
  const coordinator = new ResourceCoordinatorV1(profile);
  const sessions = Array.from({ length: limit }, (_, index) =>
    admittedSession(coordinator.admitSession(`session-${String(index)}`, 0)),
  );
  expect(coordinator.admitSession("overflow", 0)).toEqual({
    kind: "rejected",
    reason: "category-count-limit",
  });
  for (const session of sessions) session.release();
  expect(coordinator.snapshot().balanced).toBe(true);
}
