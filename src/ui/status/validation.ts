import type {
  ConflictStatusV1,
  DriftStatusV1,
  PersistenceStatusV1,
  RecoveryStatusV1,
  RelocationStatusV1,
  ResourceKindV1,
  ResourceLimitStatusV1,
  RetryStatusV1,
  StatusSnapshotV1,
  StatusValidationResultV1,
} from "./models";

const INVALID_STATUS_MESSAGE = "Invalid status model.";
const MAX_STATUS_FIELDS = 8;
const MAX_REVISION = Number.MAX_SAFE_INTEGER;
const MAX_COPY_COUNT = 3;
const MAX_RELOCATION_STEPS = 10_000;
const MAX_RECOVERY_BYTES = 33_554_432;
const MAX_RECOVERY_RECORDS = 16_384;
const MAX_RECOVERY_SUCCESSORS = 512;
const MAX_PERSISTENCE_PIPELINES = 2;
const MAX_QUEUE_TURNS = 65_536;
const MAX_SESSIONS = 65_536;
const MAX_RETRY_ATTEMPTS = 512;

const RESOURCE_CEILINGS: Readonly<Record<ResourceKindV1, number>> =
  Object.freeze({
    "recovery-bytes": MAX_RECOVERY_BYTES,
    "recovery-records": MAX_RECOVERY_RECORDS,
    "recovery-successors": MAX_RECOVERY_SUCCESSORS,
    "persistence-pipelines": MAX_PERSISTENCE_PIPELINES,
    "queue-turns": MAX_QUEUE_TURNS,
    sessions: MAX_SESSIONS,
    "conflict-copies": MAX_COPY_COUNT,
  });

const INVALID_RESULT: StatusValidationResultV1<never> = Object.freeze({
  code: "invalid-status",
  ok: false,
});

const INVALID_VALUE = Symbol("invalid-value");
type DataRecord = Record<string, unknown>;

const DRIFT_KINDS = [
  "none",
  "marker-present-sidecar-missing",
  "sidecar-present-marker-missing",
  "marker-invalid",
  "sidecar-renamed",
  "sidecar-deleted",
  "source-changed",
] as const;
const RELOCATION_SCOPES = ["note", "folder", "storage-root"] as const;
const RECOVERY_REASONS = ["backend", "quota", "corrupt", "disposed"] as const;
const RECOVERY_LIMITS = ["bytes", "records", "successors"] as const;
const RESOURCE_KINDS = [
  "recovery-bytes",
  "recovery-records",
  "recovery-successors",
  "persistence-pipelines",
  "queue-turns",
  "sessions",
  "conflict-copies",
] as const;
const RETRY_ACTIONS = [
  "save",
  "marker",
  "recovery",
  "relocation",
  "reload",
  "conflict-copy",
  "removal",
] as const;

function validRecordKeys(value: unknown): readonly string[] | null {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)
    ) {
      return null;
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > MAX_STATUS_FIELDS ||
      keys.some((key) => typeof key !== "string")
    ) {
      return null;
    }
    return keys as string[];
  } catch {
    return null;
  }
}

function readDataProperty(value: unknown, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      return INVALID_VALUE;
    }
    return descriptor.value;
  } catch {
    return INVALID_VALUE;
  }
}

function readKind(value: unknown): string | null {
  const keys = validRecordKeys(value);
  if (keys === null || keys.length === 0 || !keys.includes("kind")) {
    return null;
  }
  const kind = readDataProperty(value, "kind");
  return typeof kind === "string" ? kind : null;
}

function readClosedRecord(
  value: unknown,
  keys: readonly string[],
): DataRecord | null {
  const actual = validRecordKeys(value);
  if (actual === null) return null;
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  ) {
    return null;
  }
  const result: DataRecord = {};
  for (const key of keys) {
    const property = readDataProperty(value, key);
    if (property === INVALID_VALUE) return null;
    result[key] = property;
  }
  return result;
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
): T | null {
  return typeof value === "string" && values.includes(value as T)
    ? (value as T)
    : null;
}

function safeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : null;
}

function positiveInteger(value: unknown, maximum: number): number | null {
  return safeInteger(value, 1, maximum);
}

function nonNegativeInteger(value: unknown, maximum: number): number | null {
  return safeInteger(value, 0, maximum);
}

function validPersistenceStatus(value: unknown): PersistenceStatusV1 | null {
  const kind = readKind(value);
  switch (kind) {
    case "unannotated":
    case "first-sidecar-pending":
    case "conflict":
    case "drift":
    case "relocating":
    case "newer-version":
      return readClosedRecord(value, ["kind"]) === null
        ? null
        : Object.freeze({ kind });
    case "clean": {
      const data = readClosedRecord(value, ["kind", "sidecarRevision"]);
      const sidecarRevision =
        data === null
          ? null
          : positiveInteger(data.sidecarRevision, MAX_REVISION);
      return sidecarRevision === null
        ? null
        : Object.freeze({ kind, sidecarRevision });
    }
    case "dirty":
    case "saving": {
      const data = readClosedRecord(value, ["kind", "generation"]);
      const generation =
        data === null ? null : positiveInteger(data.generation, MAX_REVISION);
      return generation === null ? null : Object.freeze({ kind, generation });
    }
    default:
      return null;
  }
}

function validConflictStatus(value: unknown): ConflictStatusV1 | null {
  const kind = readKind(value);
  switch (kind) {
    case "none":
    case "sidecar-changed":
    case "source-changed":
    case "recovery-conflict":
    case "relocation-conflict":
      return readClosedRecord(value, ["kind"]) === null
        ? null
        : Object.freeze({ kind });
    case "location-collision": {
      const data = readClosedRecord(value, ["kind", "copyCount"]);
      const copyCount =
        data === null
          ? null
          : nonNegativeInteger(data.copyCount, MAX_COPY_COUNT);
      return copyCount === null ? null : Object.freeze({ kind, copyCount });
    }
    default:
      return null;
  }
}

function validDriftStatus(value: unknown): DriftStatusV1 | null {
  const kind = readKind(value);
  if (kind === null || !DRIFT_KINDS.includes(kind as DriftStatusV1["kind"])) {
    return null;
  }
  return readClosedRecord(value, ["kind"]) === null
    ? null
    : Object.freeze({ kind: kind as DriftStatusV1["kind"] });
}

function validRelocationStatus(value: unknown): RelocationStatusV1 | null {
  const kind = readKind(value);
  if (kind === "none") {
    return readClosedRecord(value, ["kind"]) === null
      ? null
      : Object.freeze({ kind });
  }
  if (kind === "complete" || kind === "conflict" || kind === "failed") {
    const data = readClosedRecord(value, ["kind", "scope"]);
    const scope =
      data === null ? null : enumValue(data.scope, RELOCATION_SCOPES);
    return scope === null ? null : Object.freeze({ kind, scope });
  }
  if (kind !== "relocating") return null;
  const data = readClosedRecord(value, [
    "kind",
    "scope",
    "completedSteps",
    "totalSteps",
  ]);
  if (data === null) return null;
  const scope = enumValue(data.scope, RELOCATION_SCOPES);
  const totalSteps = positiveInteger(data.totalSteps, MAX_RELOCATION_STEPS);
  const completedSteps =
    totalSteps === null
      ? null
      : nonNegativeInteger(data.completedSteps, totalSteps);
  return scope === null || totalSteps === null || completedSteps === null
    ? null
    : Object.freeze({ kind, scope, completedSteps, totalSteps });
}

function recoveryCounters(
  data: DataRecord,
): { readonly bytesUsed: number; readonly recordCount: number } | null {
  const bytesUsed = nonNegativeInteger(data.bytesUsed, MAX_RECOVERY_BYTES);
  const recordCount = nonNegativeInteger(
    data.recordCount,
    MAX_RECOVERY_RECORDS,
  );
  return bytesUsed === null || recordCount === null
    ? null
    : Object.freeze({ bytesUsed, recordCount });
}

function validRecoveryStatus(value: unknown): RecoveryStatusV1 | null {
  const kind = readKind(value);
  if (
    kind === "none" ||
    kind === "conflict" ||
    kind === "reattachment-required"
  ) {
    return readClosedRecord(value, ["kind"]) === null
      ? null
      : Object.freeze({ kind });
  }
  if (kind === "available" || kind === "pending") {
    const data = readClosedRecord(value, ["kind", "bytesUsed", "recordCount"]);
    if (data === null) return null;
    const counters = recoveryCounters(data);
    return counters === null ? null : Object.freeze({ kind, ...counters });
  }
  if (kind === "unavailable") {
    const data = readClosedRecord(value, ["kind", "reason"]);
    const reason =
      data === null ? null : enumValue(data.reason, RECOVERY_REASONS);
    return reason === null ? null : Object.freeze({ kind, reason });
  }
  if (kind !== "limited") return null;
  const data = readClosedRecord(value, ["kind", "limit"]);
  const limit = data === null ? null : enumValue(data.limit, RECOVERY_LIMITS);
  return limit === null ? null : Object.freeze({ kind, limit });
}

function validResourceLimitStatus(
  value: unknown,
): ResourceLimitStatusV1 | null {
  const kind = readKind(value);
  if (kind === "within-limit") {
    return readClosedRecord(value, ["kind"]) === null
      ? null
      : Object.freeze({ kind });
  }
  if (kind !== "limited") return null;
  const data = readClosedRecord(value, ["kind", "resource", "used", "limit"]);
  if (data === null) return null;
  const resource = enumValue(data.resource, RESOURCE_KINDS);
  if (resource === null) return null;
  const ceiling = RESOURCE_CEILINGS[resource];
  const limit = positiveInteger(data.limit, ceiling);
  const used = limit === null ? null : nonNegativeInteger(data.used, limit);
  return limit === null || used === null
    ? null
    : Object.freeze({ kind, resource, used, limit });
}

function validRetryStatus(value: unknown): RetryStatusV1 | null {
  const kind = readKind(value);
  if (kind === "not-required") {
    return readClosedRecord(value, ["kind"]) === null
      ? null
      : Object.freeze({ kind });
  }
  if (kind !== "available" && kind !== "exhausted") return null;
  const data = readClosedRecord(value, ["kind", "action", "attemptCount"]);
  if (data === null) return null;
  const action = enumValue(data.action, RETRY_ACTIONS);
  const attemptCount = nonNegativeInteger(
    data.attemptCount,
    MAX_RETRY_ATTEMPTS,
  );
  return action === null || attemptCount === null
    ? null
    : Object.freeze({ kind, action, attemptCount });
}

function validSnapshot(value: unknown): StatusSnapshotV1 | null {
  const data = readClosedRecord(value, [
    "persistence",
    "conflict",
    "drift",
    "relocation",
    "recovery",
    "resourceLimit",
    "retry",
  ]);
  if (data === null) return null;
  const persistence = validPersistenceStatus(data.persistence);
  const conflict = validConflictStatus(data.conflict);
  const drift = validDriftStatus(data.drift);
  const relocation = validRelocationStatus(data.relocation);
  const recovery = validRecoveryStatus(data.recovery);
  const resourceLimit = validResourceLimitStatus(data.resourceLimit);
  const retry = validRetryStatus(data.retry);
  return persistence === null ||
    conflict === null ||
    drift === null ||
    relocation === null ||
    recovery === null ||
    resourceLimit === null ||
    retry === null
    ? null
    : Object.freeze({
        persistence,
        conflict,
        drift,
        relocation,
        recovery,
        resourceLimit,
        retry,
      });
}

function success<T>(value: T): StatusValidationResultV1<T> {
  return Object.freeze({ ok: true, value });
}

function create<T>(
  value: unknown,
  parser: (candidate: unknown) => T | null,
): StatusValidationResultV1<T> {
  try {
    const parsed = parser(value);
    return parsed === null ? INVALID_RESULT : success(parsed);
  } catch {
    return INVALID_RESULT;
  }
}

function throwIfInvalid<T>(result: StatusValidationResultV1<T>): T {
  if (!result.ok) throw new TypeError(INVALID_STATUS_MESSAGE);
  return result.value;
}

export const tryCreatePersistenceStatus = (
  value: unknown,
): StatusValidationResultV1<PersistenceStatusV1> =>
  create(value, validPersistenceStatus);

export const createPersistenceStatus = (value: unknown): PersistenceStatusV1 =>
  throwIfInvalid(tryCreatePersistenceStatus(value));

export const tryCreateConflictStatus = (
  value: unknown,
): StatusValidationResultV1<ConflictStatusV1> =>
  create(value, validConflictStatus);

export const createConflictStatus = (value: unknown): ConflictStatusV1 =>
  throwIfInvalid(tryCreateConflictStatus(value));

export const tryCreateDriftStatus = (
  value: unknown,
): StatusValidationResultV1<DriftStatusV1> => create(value, validDriftStatus);

export const createDriftStatus = (value: unknown): DriftStatusV1 =>
  throwIfInvalid(tryCreateDriftStatus(value));

export const tryCreateRelocationStatus = (
  value: unknown,
): StatusValidationResultV1<RelocationStatusV1> =>
  create(value, validRelocationStatus);

export const createRelocationStatus = (value: unknown): RelocationStatusV1 =>
  throwIfInvalid(tryCreateRelocationStatus(value));

export const tryCreateRecoveryStatus = (
  value: unknown,
): StatusValidationResultV1<RecoveryStatusV1> =>
  create(value, validRecoveryStatus);

export const createRecoveryStatus = (value: unknown): RecoveryStatusV1 =>
  throwIfInvalid(tryCreateRecoveryStatus(value));

export const tryCreateResourceLimitStatus = (
  value: unknown,
): StatusValidationResultV1<ResourceLimitStatusV1> =>
  create(value, validResourceLimitStatus);

export const createResourceLimitStatus = (
  value: unknown,
): ResourceLimitStatusV1 => throwIfInvalid(tryCreateResourceLimitStatus(value));

export const tryCreateRetryStatus = (
  value: unknown,
): StatusValidationResultV1<RetryStatusV1> => create(value, validRetryStatus);

export const createRetryStatus = (value: unknown): RetryStatusV1 =>
  throwIfInvalid(tryCreateRetryStatus(value));

export const tryCreateStatusSnapshot = (
  value: unknown,
): StatusValidationResultV1<StatusSnapshotV1> => create(value, validSnapshot);

export const createStatusSnapshot = (value: unknown): StatusSnapshotV1 =>
  throwIfInvalid(tryCreateStatusSnapshot(value));
