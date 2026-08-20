import type {
  CommandResultV1,
  RecoveryAttemptId,
} from "../../application/note-session";
import type { SourceCheckpointOperationV1 } from "../../application/source-coordination";
import {
  decodeRecoveryRecordV1,
  isTerminalRelocation,
  isTerminalRemoval,
  validateRelocationStart,
  validateRelocationTransition,
  validateRemovalStart,
  validateRemovalTransition,
  type HostAcknowledgementV1,
  type HostRecordedDirectionAttemptV1,
  type HostRecordedForwardAttemptV1,
  type PreparedForwardAttemptV1,
  type RecoveryPersistenceRecordV1,
  type RecoverySagaCompletionV1,
  type RelocationRecordV1,
  type RelocationTransitionV1,
  type RemovalRecordV1,
  type RemovalTransitionV1,
} from "../../application/recovery";
import {
  applyAccountingDelta,
  readAccounting,
  writeAccounting,
} from "./accounting";
import { requestResult } from "./idb-promises";
import { deletePrefixRelocationPlan } from "./prefix-plan";
import {
  conflict,
  insertRecord,
  replaceRecord,
  success,
} from "./record-admission";
import { readRecordByKey } from "./read-record";
import {
  insertPrefixRelocationRecord,
  retainCompletedPrefixRule,
} from "./retained-prefix-rules";
import {
  createStoredRecord,
  decodeStoredRecordInTransaction,
  storedPayloadEqual,
} from "./record-storage";
import { RECORDS_STORE, type StoredRecoveryRecord } from "./schema";
import { runMutation, type MutationContext } from "./transactions";
import type { IndexedDbRecoveryLimits } from "./types";

const DELETE_ONE_RECORD = -1;

export interface WriteContext extends MutationContext {
  readonly limits: IndexedDbRecoveryLimits;
}

export async function prepareForward(
  context: WriteContext,
  attempt: PreparedForwardAttemptV1,
  admittedBytes?: Uint8Array,
): Promise<CommandResultV1<void>> {
  return appendRecord(context, "prepare-forward", attempt, admittedBytes);
}

export async function appendDirection(
  context: WriteContext,
  attempt: HostRecordedDirectionAttemptV1,
  admittedBytes?: Uint8Array,
): Promise<CommandResultV1<void>> {
  return appendRecord(context, "append-direction", attempt, admittedBytes);
}

export async function appendSourceCheckpoint(
  context: WriteContext,
  checkpoint: SourceCheckpointOperationV1,
  admittedBytes?: Uint8Array,
): Promise<CommandResultV1<void>> {
  return appendRecord(context, "append-checkpoint", checkpoint, admittedBytes);
}

export async function beginRelocation(
  context: WriteContext,
  record: RelocationRecordV1,
  admittedBytes?: Uint8Array,
): Promise<CommandResultV1<void>> {
  const validated = validateRelocationStart(record);
  if (!validated.ok) return validated;
  return appendRecord(context, "begin-relocation", record, admittedBytes);
}

export async function beginRemoval(
  context: WriteContext,
  record: RemovalRecordV1,
  admittedBytes?: Uint8Array,
): Promise<CommandResultV1<void>> {
  const validated = validateRemovalStart(record);
  if (!validated.ok) return validated;
  return appendRecord(context, "begin-removal", record, admittedBytes);
}

export async function recordForward(
  context: WriteContext,
  attemptId: RecoveryAttemptId,
  acknowledgement: HostAcknowledgementV1,
): Promise<CommandResultV1<HostRecordedForwardAttemptV1>> {
  if (!/^ra_[0-7][0-9a-hjkmnp-tv-z]{25}$/u.test(attemptId)) {
    return { ok: false, code: "invalid-command" };
  }
  const existing = await readRecordByKey(
    context.database,
    `attempt:${attemptId}`,
  );
  if (!existing.ok) return existing;
  if (existing.value === null || !("attemptId" in existing.value.record)) {
    return conflict();
  }
  const prior = existing.value.record;
  if (
    prior.kind !== "prepared-forward" &&
    prior.kind !== "host-recorded-forward"
  ) {
    return conflict();
  }
  const replacement = {
    ...prior,
    acknowledgement,
    kind: "host-recorded-forward" as const,
  };
  const candidate = await createStoredRecord(replacement);
  if (!candidate.ok) return candidate;
  const durable = decodeRecoveryRecordV1(candidate.value.encoded);
  if (
    !durable.ok ||
    !("attemptId" in durable.value) ||
    durable.value.kind !== "host-recorded-forward"
  ) {
    return { ok: false, code: "recovery-unavailable" };
  }
  const durableAttempt = durable.value;
  if (prior.kind === "host-recorded-forward") {
    return storedPayloadEqual(existing.value.stored, candidate.value)
      ? { ok: true, value: prior }
      : conflict();
  }
  const persisted = await replaceWithCas(
    context,
    "record-forward",
    existing.value.stored,
    replacement,
    candidate.value,
  );
  return persisted.ok ? { ok: true, value: durableAttempt } : persisted;
}

export async function advanceRelocation(
  context: WriteContext,
  transition: RelocationTransitionV1,
  expectedBytes?: Uint8Array,
  replacementBytes?: Uint8Array,
): Promise<CommandResultV1<void>> {
  const validated = validateRelocationTransition(transition);
  if (!validated.ok) return validated;
  return replaceSupplied(
    context,
    "advance-relocation",
    transition.expected,
    transition.replacement,
    expectedBytes,
    replacementBytes,
  );
}

export async function advanceRemoval(
  context: WriteContext,
  transition: RemovalTransitionV1,
  expectedBytes?: Uint8Array,
  replacementBytes?: Uint8Array,
): Promise<CommandResultV1<void>> {
  const validated = validateRemovalTransition(transition);
  if (!validated.ok) return validated;
  return replaceSupplied(
    context,
    "advance-removal",
    transition.expected,
    transition.replacement,
    expectedBytes,
    replacementBytes,
  );
}

export async function completeSaga(
  context: WriteContext,
  request: RecoverySagaCompletionV1,
): Promise<CommandResultV1<void>> {
  const key = `${request.kind}:${request.id}`;
  const prior = await readRecordByKey(context.database, key);
  if (!prior.ok) return prior;
  if (prior.value === null) return conflict();
  const verified = prior.value;
  if (
    verified.stored.sha256 !== request.expectedTerminalRecordSha256 ||
    !isTerminalSaga(verified.record, request.kind)
  ) {
    return conflict();
  }
  return runMutation(context, "complete-saga", async (transaction) => {
    const records = transaction.objectStore(RECORDS_STORE);
    const value = await requestResult(records.get(key) as IDBRequest<unknown>);
    const current = decodeStoredRecordInTransaction(value, key);
    if (
      !current.ok ||
      !storedPayloadEqual(current.value.stored, verified.stored)
    ) {
      return conflict();
    }
    if (isPrefixRecord(current.value.record)) {
      if (current.value.stored.activePrefixRelocation === "retained") {
        return success();
      }
      const deletedPlan = await deletePrefixRelocationPlan(
        transaction,
        current.value.record,
      );
      return deletedPlan.ok
        ? retainCompletedPrefixRule(
            transaction,
            current.value.stored,
            current.value.record,
          )
        : deletedPlan;
    }
    return deleteStoredRecord(transaction, current.value.stored);
  });
}

async function appendRecord(
  context: WriteContext,
  operation:
    | "prepare-forward"
    | "append-direction"
    | "append-checkpoint"
    | "begin-relocation"
    | "begin-removal",
  record: RecoveryPersistenceRecordV1,
  admittedBytes?: Uint8Array,
): Promise<CommandResultV1<void>> {
  const stored = await createStoredRecord(record, admittedBytes);
  if (!stored.ok) return stored;
  return runMutation(context, operation, (transaction) =>
    isPrefixRecord(record)
      ? insertPrefixRelocationRecord(
          transaction,
          stored.value,
          record,
          context.limits,
        )
      : insertRecord(transaction, stored.value, context.limits),
  );
}

async function replaceSupplied(
  context: WriteContext,
  operation: "advance-relocation" | "advance-removal",
  expected: RecoveryPersistenceRecordV1,
  replacement: RecoveryPersistenceRecordV1,
  expectedBytes?: Uint8Array,
  replacementBytes?: Uint8Array,
): Promise<CommandResultV1<void>> {
  const prior = await createStoredRecord(expected, expectedBytes);
  const next = await createStoredRecord(replacement, replacementBytes);
  if (!prior.ok) return prior;
  if (!next.ok) return next;
  return replaceWithCas(
    context,
    operation,
    prior.value,
    replacement,
    next.value,
  );
}

async function replaceWithCas(
  context: WriteContext,
  operation: "record-forward" | "advance-relocation" | "advance-removal",
  expected: StoredRecoveryRecord,
  replacementRecord: RecoveryPersistenceRecordV1,
  preparedReplacement?: StoredRecoveryRecord,
): Promise<CommandResultV1<void>> {
  const encodedReplacement =
    preparedReplacement === undefined
      ? await createStoredRecord(replacementRecord)
      : { ok: true as const, value: preparedReplacement };
  if (!encodedReplacement.ok) return encodedReplacement;
  const replacement = encodedReplacement.value;
  if (expected.key !== replacement.key) return conflict();
  return runMutation(context, operation, async (transaction) => {
    const value = await requestResult(
      transaction
        .objectStore(RECORDS_STORE)
        .get(expected.key) as IDBRequest<unknown>,
    );
    const current = decodeStoredRecordInTransaction(value, expected.key);
    if (!current.ok) return conflict();
    if (storedPayloadEqual(current.value.stored, replacement)) {
      return success();
    }
    if (!storedPayloadEqual(current.value.stored, expected)) {
      return conflict();
    }
    return replaceRecord(
      transaction,
      current.value.stored,
      replacement,
      context.limits,
    );
  });
}

function isTerminalSaga(
  record: RecoveryPersistenceRecordV1,
  kind: "relocation" | "removal",
): boolean {
  if (kind === "removal") {
    return (
      "kind" in record &&
      record.kind === "annotation-removal" &&
      isTerminalRemoval(record)
    );
  }
  return "relocationId" in record && isTerminalRelocation(record);
}

function isPrefixRecord(
  record: RecoveryPersistenceRecordV1,
): record is Extract<
  RelocationRecordV1,
  { kind: "folder-prefix" | "storage-root" }
> {
  return (
    "relocationId" in record &&
    (record.kind === "folder-prefix" || record.kind === "storage-root")
  );
}

async function deleteStoredRecord(
  transaction: IDBTransaction,
  stored: StoredRecoveryRecord,
): Promise<CommandResultV1<void>> {
  const accounting = await readAccounting(transaction, stored.noteKey);
  const replacement = applyAccountingDelta(
    accounting,
    -stored.byteSize,
    DELETE_ONE_RECORD,
    undefined,
    stored.noteKey !== null,
  );
  if (replacement === null) return { ok: false, code: "recovery-unavailable" };
  transaction.objectStore(RECORDS_STORE).delete(stored.key);
  writeAccounting(transaction, stored.noteKey, replacement);
  return success();
}
