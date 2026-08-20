import { expect, it } from "vitest";

import {
  createConflictStatus,
  createDriftStatus,
  createPersistenceStatus,
  createRecoveryStatus,
  createRelocationStatus,
  createResourceLimitStatus,
  createRetryStatus,
  createStatusSnapshot,
  tryCreateConflictStatus,
  tryCreateDriftStatus,
  tryCreatePersistenceStatus,
  tryCreateRecoveryStatus,
  tryCreateRelocationStatus,
  tryCreateResourceLimitStatus,
  tryCreateRetryStatus,
  tryCreateStatusSnapshot,
} from "../../../src/ui/status";

const RECOVERY_BYTES = 33_554_432;
const RECOVERY_RECORDS = 16_384;
const MAX_COPY_COUNT = 3;
const OVER_LIMIT_STATUS_FIELDS = 9;

function completeSnapshot(): Record<string, unknown> {
  return {
    persistence: { kind: "clean", sidecarRevision: 2 },
    conflict: { kind: "none" },
    drift: { kind: "none" },
    relocation: { kind: "none" },
    recovery: {
      kind: "available",
      bytesUsed: RECOVERY_BYTES,
      recordCount: RECOVERY_RECORDS,
    },
    resourceLimit: {
      kind: "limited",
      resource: "recovery-bytes",
      used: RECOVERY_BYTES,
      limit: RECOVERY_BYTES,
    },
    retry: { kind: "available", action: "save", attemptCount: 0 },
  };
}

it("creates every status family from closed records", () => {
  expect(createPersistenceStatus({ kind: "dirty", generation: 4 })).toEqual({
    kind: "dirty",
    generation: 4,
  });
  expect(
    createConflictStatus({ kind: "location-collision", copyCount: 2 }),
  ).toEqual({
    kind: "location-collision",
    copyCount: 2,
  });
  expect(createDriftStatus({ kind: "marker-invalid" })).toEqual({
    kind: "marker-invalid",
  });
  expect(
    createRelocationStatus({
      kind: "relocating",
      scope: "folder",
      completedSteps: 2,
      totalSteps: 5,
    }),
  ).toEqual({
    kind: "relocating",
    scope: "folder",
    completedSteps: 2,
    totalSteps: 5,
  });
  expect(
    createRecoveryStatus({
      kind: "unavailable",
      reason: "quota",
    }),
  ).toEqual({ kind: "unavailable", reason: "quota" });
  expect(
    createResourceLimitStatus({
      kind: "limited",
      resource: "conflict-copies",
      used: MAX_COPY_COUNT,
      limit: MAX_COPY_COUNT,
    }),
  ).toEqual({
    kind: "limited",
    resource: "conflict-copies",
    used: MAX_COPY_COUNT,
    limit: MAX_COPY_COUNT,
  });
  expect(
    createRetryStatus({
      kind: "exhausted",
      action: "recovery",
      attemptCount: 512,
    }),
  ).toEqual({ kind: "exhausted", action: "recovery", attemptCount: 512 });
});

it.each([
  "unannotated",
  "first-sidecar-pending",
  "conflict",
  "drift",
  "relocating",
  "newer-version",
])("creates the fieldless persistence status %s", (kind) => {
  expect(createPersistenceStatus({ kind })).toEqual({ kind });
});

it.each(["dirty", "saving"])(
  "creates the generation persistence status %s",
  (kind) => {
    expect(createPersistenceStatus({ kind, generation: 1 })).toEqual({
      kind,
      generation: 1,
    });
  },
);

it.each([
  "none",
  "sidecar-changed",
  "source-changed",
  "recovery-conflict",
  "relocation-conflict",
])("creates the fieldless conflict status %s", (kind) => {
  expect(createConflictStatus({ kind })).toEqual({ kind });
});

it.each([
  "none",
  "marker-present-sidecar-missing",
  "sidecar-present-marker-missing",
  "marker-invalid",
  "sidecar-renamed",
  "sidecar-deleted",
  "source-changed",
])("creates the drift status %s", (kind) => {
  expect(createDriftStatus({ kind })).toEqual({ kind });
});

it.each([
  ["complete", "note"],
  ["conflict", "folder"],
  ["failed", "storage-root"],
] as const)("creates the %s relocation status", (kind, scope) => {
  expect(createRelocationStatus({ kind, scope })).toEqual({ kind, scope });
});

it.each(["none", "conflict", "reattachment-required"])(
  "creates the fieldless recovery status %s",
  (kind) => {
    expect(createRecoveryStatus({ kind })).toEqual({ kind });
  },
);

it("creates pending and limited recovery statuses", () => {
  expect(
    createRecoveryStatus({ kind: "pending", bytesUsed: 0, recordCount: 0 }),
  ).toEqual({ kind: "pending", bytesUsed: 0, recordCount: 0 });
  expect(
    createRecoveryStatus({ kind: "limited", limit: "successors" }),
  ).toEqual({ kind: "limited", limit: "successors" });
});

it("creates fieldless resource and retry statuses", () => {
  expect(createResourceLimitStatus({ kind: "within-limit" })).toEqual({
    kind: "within-limit",
  });
  expect(createRetryStatus({ kind: "not-required" })).toEqual({
    kind: "not-required",
  });
});

it("creates a deeply frozen aggregate snapshot", () => {
  const input = completeSnapshot();
  const snapshot = createStatusSnapshot(input);

  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.persistence)).toBe(true);
  expect(Object.isFrozen(snapshot.recovery)).toBe(true);
  expect(Object.isFrozen(snapshot.resourceLimit)).toBe(true);
  expect(Object.isFrozen(snapshot.retry)).toBe(true);

  input.persistence = { kind: "conflict" };
  expect(snapshot.persistence).toEqual({ kind: "clean", sidecarRevision: 2 });
});

it("returns a closed failure without exposing rejected input", () => {
  const failure = tryCreatePersistenceStatus({
    kind: "clean",
    sidecarRevision: 1,
    untrustedValue: "not-for-status",
  });

  expect(failure).toEqual({ ok: false, code: "invalid-status" });
  expect(JSON.stringify(failure)).not.toContain("not-for-status");
  expect(() =>
    createPersistenceStatus({ kind: "clean", sidecarRevision: 0 }),
  ).toThrow("Invalid status model.");
});

it.each([
  { kind: "clean", sidecarRevision: 0 },
  { kind: "clean", sidecarRevision: Number.NaN },
  { kind: "dirty", generation: Number.POSITIVE_INFINITY },
  { kind: "location-collision", copyCount: MAX_COPY_COUNT + 1 },
  { kind: "relocating", scope: "note", completedSteps: 4, totalSteps: 3 },
  { kind: "available", bytesUsed: RECOVERY_BYTES + 1, recordCount: 0 },
  { kind: "limited", resource: "recovery-records", used: 2, limit: 1 },
  { kind: "available", action: "save", attemptCount: 0 },
])("rejects malformed status records %#", (value) => {
  expect(tryCreatePersistenceStatus(value).ok).toBe(false);
  expect(() => createStatusSnapshot(value)).toThrow("Invalid status model.");
});

it("rejects accessor and revoked proxy records without reading getters", () => {
  let getterReads = 0;
  const accessor = Object.defineProperty({ kind: "clean" }, "sidecarRevision", {
    enumerable: true,
    get: (): never => {
      getterReads += 1;
      throw new Error("getter must not run");
    },
  });

  expect(tryCreatePersistenceStatus(accessor).ok).toBe(false);
  expect(getterReads).toBe(0);

  const revocable = Proxy.revocable({ kind: "clean", sidecarRevision: 1 }, {});
  revocable.revoke();
  expect(tryCreatePersistenceStatus(revocable.proxy)).toEqual({
    ok: false,
    code: "invalid-status",
  });
});

it("does not invoke hostile proxy getters", (): void => {
  let reads = 0;
  const proxy = new Proxy(
    { kind: "clean", sidecarRevision: 1 },
    {
      get: (): never => {
        reads += 1;
        throw new Error("hostile getter");
      },
    },
  );

  expect(tryCreatePersistenceStatus(proxy).ok).toBe(true);
  expect(reads).toBe(0);
});

it.each([
  null,
  [],
  Object.create({ kind: "clean" }),
  { kind: 1 },
  { sidecarRevision: 1 },
  Object.defineProperty({}, "kind", { value: "clean" }),
  Object.fromEntries(
    Array.from({ length: OVER_LIMIT_STATUS_FIELDS }, (_, index) => [
      `field-${String(index)}`,
      true,
    ]),
  ),
])("rejects structurally unsafe records %#", (value) => {
  expect(tryCreatePersistenceStatus(value).ok).toBe(false);
});

it("rejects symbol properties and property-descriptor failures", () => {
  expect(
    tryCreatePersistenceStatus({
      kind: "clean",
      sidecarRevision: 1,
      [Symbol()]: 1,
    }).ok,
  ).toBe(false);

  const descriptorFailure = new Proxy(
    { kind: "clean", sidecarRevision: 1 },
    {
      getOwnPropertyDescriptor: (): never => {
        throw new Error("descriptor unavailable");
      },
    },
  );
  expect(tryCreatePersistenceStatus(descriptorFailure).ok).toBe(false);
});

it("rejects every status family at its trust boundaries", () => {
  expect(tryCreatePersistenceStatus({ kind: "unknown" }).ok).toBe(false);
  expect(
    tryCreatePersistenceStatus({ kind: "saving", generation: 1, extra: true })
      .ok,
  ).toBe(false);
  expect(
    tryCreatePersistenceStatus({ kind: "saving", generation: -1 }).ok,
  ).toBe(false);
  expect(tryCreateConflictStatus({ kind: "unknown" }).ok).toBe(false);
  expect(tryCreateConflictStatus({ kind: "none", extra: true }).ok).toBe(false);
  expect(tryCreateConflictStatus({ kind: "location-collision" }).ok).toBe(
    false,
  );
  expect(
    tryCreateConflictStatus({ kind: "location-collision", copyCount: -1 }).ok,
  ).toBe(false);
  expect(tryCreateDriftStatus({ kind: "unknown" }).ok).toBe(false);
  expect(tryCreateDriftStatus({ kind: "none", extra: true }).ok).toBe(false);
  expect(tryCreateRelocationStatus({ kind: "unknown" }).ok).toBe(false);
  expect(tryCreateRelocationStatus({ kind: "none", extra: true }).ok).toBe(
    false,
  );
  expect(
    tryCreateRelocationStatus({ kind: "complete", scope: "note", extra: true })
      .ok,
  ).toBe(false);
  expect(
    tryCreateRelocationStatus({ kind: "complete", scope: "unknown" }).ok,
  ).toBe(false);
  expect(
    tryCreateRelocationStatus({
      kind: "relocating",
      scope: "note",
      completedSteps: 0,
      totalSteps: 1,
      extra: true,
    }).ok,
  ).toBe(false);
  expect(
    tryCreateRelocationStatus({
      kind: "relocating",
      scope: "note",
      completedSteps: 0,
      totalSteps: 0,
    }).ok,
  ).toBe(false);
  expect(
    tryCreateRelocationStatus({
      kind: "relocating",
      scope: "unknown",
      completedSteps: 0,
      totalSteps: 1,
    }).ok,
  ).toBe(false);
});

it("rejects recovery and retry status trust-boundary violations", () => {
  expect(tryCreateRecoveryStatus({ kind: "unknown" }).ok).toBe(false);
  expect(tryCreateRecoveryStatus({ kind: "none", extra: true }).ok).toBe(false);
  expect(
    tryCreateRecoveryStatus({
      kind: "available",
      bytesUsed: 0,
      recordCount: 0,
      extra: true,
    }).ok,
  ).toBe(false);
  expect(
    tryCreateRecoveryStatus({
      kind: "available",
      bytesUsed: 0,
      recordCount: -1,
    }).ok,
  ).toBe(false);
  expect(
    tryCreateRecoveryStatus({ kind: "unavailable", reason: "unknown" }).ok,
  ).toBe(false);
  expect(
    tryCreateRecoveryStatus({
      kind: "unavailable",
      reason: "quota",
      extra: true,
    }).ok,
  ).toBe(false);
  expect(
    tryCreateRecoveryStatus({ kind: "limited", limit: "unknown" }).ok,
  ).toBe(false);
  expect(
    tryCreateRecoveryStatus({ kind: "limited", limit: "bytes", extra: true })
      .ok,
  ).toBe(false);
  expect(tryCreateResourceLimitStatus({ kind: "unknown" }).ok).toBe(false);
  expect(
    tryCreateResourceLimitStatus({ kind: "within-limit", extra: true }).ok,
  ).toBe(false);
  expect(
    tryCreateResourceLimitStatus({
      kind: "limited",
      resource: "sessions",
      used: 0,
      limit: 1,
      extra: true,
    }).ok,
  ).toBe(false);
  expect(
    tryCreateResourceLimitStatus({
      kind: "limited",
      resource: "unknown",
      used: 0,
      limit: 1,
    }).ok,
  ).toBe(false);
  expect(
    tryCreateResourceLimitStatus({
      kind: "limited",
      resource: "sessions",
      used: 0,
      limit: 0,
    }).ok,
  ).toBe(false);
  expect(tryCreateRetryStatus({ kind: "unknown" }).ok).toBe(false);
  expect(tryCreateRetryStatus({ kind: "not-required", extra: true }).ok).toBe(
    false,
  );
  expect(
    tryCreateRetryStatus({
      kind: "available",
      action: "save",
      attemptCount: 0,
      extra: true,
    }).ok,
  ).toBe(false);
  expect(
    tryCreateRetryStatus({
      kind: "available",
      action: "unknown",
      attemptCount: 0,
    }).ok,
  ).toBe(false);
  expect(
    tryCreateRetryStatus({
      kind: "available",
      action: "save",
      attemptCount: -1,
    }).ok,
  ).toBe(false);
});

it("rejects an aggregate when any nested family is invalid", () => {
  const fieldByField = [
    ["persistence", { kind: "unknown" }],
    ["conflict", { kind: "unknown" }],
    ["drift", { kind: "unknown" }],
    ["relocation", { kind: "unknown" }],
    ["recovery", { kind: "unknown" }],
    ["resourceLimit", { kind: "unknown" }],
    ["retry", { kind: "unknown" }],
  ] as const;

  for (const [field, invalid] of fieldByField) {
    expect(
      tryCreateStatusSnapshot({ ...completeSnapshot(), [field]: invalid }).ok,
    ).toBe(false);
  }
  expect(tryCreateStatusSnapshot({}).ok).toBe(false);
});
