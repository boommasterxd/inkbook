import type { CommandResultV1 } from "../../application/note-session";
import {
  isValidNoteIdentity,
  isValidSidecarBase,
  sameSidecarBase,
  type DiscardConfirmedNoteRecoveryV1,
  type RecoveryAttemptV1,
  type RecoveryPersistenceRecordV1,
  type SidecarBaseIdentityV1,
} from "../../application/recovery";
import type { SourceCheckpointOperationV1 } from "../../application/source-coordination";
import {
  applyAccountingDelta,
  readAccounting,
  writeAccounting,
} from "./accounting";
import { requestResult } from "./idb-promises";
import { admitQueueRequest, admitRecoveryRecord } from "./queue-admission";
import { bytesEqual, decodeStoredRecordInTransaction } from "./record-storage";
import {
  NOTE_KEY_INDEX,
  RECORDS_STORE,
  type StoredRecoveryRecord,
} from "./schema";
import { runMutation } from "./transactions";
import type { WriteContext } from "./write-operations";

export interface ExpectedNoteRecoveryRecordV1 {
  readonly encoded: Uint8Array;
  readonly key: string;
}

export interface PreparedRecoveryDiscardV1 {
  readonly expected: ReadonlyMap<string, ExpectedNoteRecoveryRecordV1>;
  readonly expectedBase: DiscardConfirmedNoteRecoveryV1["expectedBase"];
  readonly noteKey: string;
  readonly retainedBytes: number;
}

export function prepareRecoveryDiscard(
  request: DiscardConfirmedNoteRecoveryV1,
  context: WriteContext,
): CommandResultV1<PreparedRecoveryDiscardV1> {
  const input = readDiscardRequest(request, context.limits.noteRecords);
  if (!input.ok) return input;
  const metadata = admitQueueRequest({
    expectedBase: input.value.expectedBase,
    noteIdentity: input.value.noteIdentity,
  });
  if (!metadata.ok) return metadata;
  const expectedBase = metadata.value.value.expectedBase;
  const noteIdentity = metadata.value.value.noteIdentity;
  if (
    !isValidNoteIdentity(noteIdentity) ||
    !isValidSidecarBase(expectedBase) ||
    noteIdentity.vaultRelativeMarkdownPath !== expectedBase.markdownPath
  ) {
    return failure("invalid-command");
  }
  const records = [
    ...input.value.expectedAttempts,
    ...input.value.expectedCheckpoints,
  ];
  const expected = new Map<string, ExpectedNoteRecoveryRecordV1>();
  let retainedBytes = 0;
  for (const record of records) {
    if (!sameSidecarBase(record.base, expectedBase)) {
      return failure("sidecar-conflict");
    }
    const admitted = admitRecoveryRecord(record);
    if (!admitted.ok) return admitted;
    const key = recoveryRecordKey(admitted.value.record);
    if (expected.has(key)) return failure("sidecar-conflict");
    retainedBytes += admitted.value.bytes.byteLength;
    if (retainedBytes > context.limits.noteBytes) {
      return failure("recovery-limit");
    }
    expected.set(key, Object.freeze({ encoded: admitted.value.bytes, key }));
  }
  return {
    ok: true,
    value: Object.freeze({
      expected,
      expectedBase,
      noteKey: noteIdentity.vaultRelativeMarkdownPath,
      retainedBytes,
    }),
  };
}

function readDiscardRequest(
  value: unknown,
  maxRecords: number,
): CommandResultV1<
  Readonly<{
    expectedAttempts: readonly RecoveryAttemptV1[];
    expectedBase: unknown;
    expectedCheckpoints: readonly SourceCheckpointOperationV1[];
    noteIdentity: unknown;
  }>
> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return failure("invalid-command");
    }
    const expectedKeys = [
      "expectedAttempts",
      "expectedBase",
      "expectedCheckpoints",
      "noteIdentity",
    ] as const;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length ||
      !expectedKeys.every((key) => keys.includes(key))
    ) {
      return failure("invalid-command");
    }
    const attempts = readRecordArray(
      dataProperty(value, "expectedAttempts"),
      maxRecords,
    );
    if (!attempts.ok) return attempts;
    const checkpoints = readRecordArray(
      dataProperty(value, "expectedCheckpoints"),
      maxRecords - attempts.value.length,
    );
    if (!checkpoints.ok) return checkpoints;
    return {
      ok: true,
      value: Object.freeze({
        expectedAttempts: attempts.value as readonly RecoveryAttemptV1[],
        expectedBase: dataProperty(value, "expectedBase"),
        expectedCheckpoints:
          checkpoints.value as readonly SourceCheckpointOperationV1[],
        noteIdentity: dataProperty(value, "noteIdentity"),
      }),
    };
  } catch {
    return failure("invalid-command");
  }
}

function readRecordArray(
  value: unknown,
  maxLength: number,
): CommandResultV1<readonly unknown[]> {
  if (!Array.isArray(value)) return failure("invalid-command");
  const length = dataProperty(value, "length", false);
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0
  ) {
    return failure("invalid-command");
  }
  if (length > maxLength) return failure("recovery-limit");
  if (Reflect.ownKeys(value).length !== length + 1) {
    return failure("invalid-command");
  }
  const records: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    records.push(dataProperty(value, String(index)));
  }
  return { ok: true, value: Object.freeze(records) };
}

function dataProperty(
  value: object,
  key: PropertyKey,
  enumerable = true,
): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    descriptor.enumerable !== enumerable
  ) {
    throw new TypeError("Expected a plain data property.");
  }
  return descriptor.value;
}

export function discardConfirmedNoteRecovery(
  context: WriteContext,
  prepared: PreparedRecoveryDiscardV1,
): Promise<CommandResultV1<void>> {
  return runMutation(
    context,
    "discard-confirmed-note-recovery",
    async (transaction) => applyDiscard(transaction, context, prepared),
  );
}

async function applyDiscard(
  transaction: IDBTransaction,
  context: WriteContext,
  prepared: PreparedRecoveryDiscardV1,
): Promise<CommandResultV1<void>> {
  return deleteExactNoteRecoveryRecords(transaction, context, prepared);
}

export async function deleteExactNoteRecoveryRecords(
  transaction: IDBTransaction,
  context: WriteContext,
  prepared: PreparedRecoveryDiscardV1,
): Promise<CommandResultV1<void>> {
  const records = transaction.objectStore(RECORDS_STORE);
  const values = await requestResult(
    records
      .index(NOTE_KEY_INDEX)
      .getAll(prepared.noteKey, context.limits.noteRecords + 1) as IDBRequest<
      unknown[]
    >,
  );
  if (values.length > context.limits.noteRecords) {
    return failure("recovery-limit");
  }
  const current = materializeCurrent(values, prepared);
  if (!current.ok) return current;
  const accounting = await readAccounting(transaction, prepared.noteKey);
  if (
    accounting.note.records !== current.value.length ||
    accounting.note.bytes !== sumBytes(current.value)
  ) {
    return failure("recovery-unavailable");
  }
  const adjusted = applyAccountingDelta(
    accounting,
    -accounting.note.bytes,
    -accounting.note.records,
  );
  if (adjusted === null) return failure("recovery-unavailable");
  for (const stored of current.value) records.delete(stored.key);
  writeAccounting(transaction, prepared.noteKey, adjusted);
  return { ok: true, value: undefined };
}

function materializeCurrent(
  values: readonly unknown[],
  prepared: PreparedRecoveryDiscardV1,
): CommandResultV1<readonly StoredRecoveryRecord[]> {
  if (values.length !== prepared.expected.size) {
    return failure("sidecar-conflict");
  }
  const current: StoredRecoveryRecord[] = [];
  for (const value of values) {
    const decoded = decodeStoredRecordInTransaction(value);
    if (!decoded.ok) return failure("recovery-unavailable");
    const record = decoded.value.record;
    const base = recoveryRecordBase(record);
    if (
      base === null ||
      !sameSidecarBase(base, prepared.expectedBase) ||
      decoded.value.stored.noteKey !== prepared.noteKey
    ) {
      return failure("sidecar-conflict");
    }
    const expected = prepared.expected.get(decoded.value.stored.key);
    if (
      expected === undefined ||
      !bytesEqual(expected.encoded, decoded.value.stored.encoded)
    ) {
      return failure("sidecar-conflict");
    }
    current.push(decoded.value.stored);
  }
  return { ok: true, value: current };
}

function recoveryRecordBase(
  record: RecoveryPersistenceRecordV1,
): SidecarBaseIdentityV1 | null {
  if ("base" in record) return record.base;
  return "sidecarBase" in record ? record.sidecarBase : null;
}

function recoveryRecordKey(
  record: RecoveryAttemptV1 | SourceCheckpointOperationV1,
): string {
  return "attemptId" in record
    ? `attempt:${record.attemptId}`
    : `checkpoint:${record.checkpointId}`;
}

function sumBytes(records: readonly StoredRecoveryRecord[]): number {
  return records.reduce((total, record) => total + record.byteSize, 0);
}

function failure<T = never>(
  code: Exclude<CommandResultV1<never>, { readonly ok: true }>["code"],
): CommandResultV1<T> {
  return { code, ok: false };
}
