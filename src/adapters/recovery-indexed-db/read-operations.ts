import { readByteUsage } from "./accounting";
import { mapIndexedDbFailure } from "./error-mapping";
import { requestResult, transactionDone } from "./idb-promises";
import { recoveryNoteKey } from "./record-codec";
import {
  ACCOUNTING_STORE,
  ATTEMPTS_STORE,
  NOTE_KEY_INDEX,
  type StoredAttempt,
} from "./schema";
import { validateStoredAttempt } from "./stored-attempt";
import type {
  RecoveryByteUsage,
  RecoveryLoadResult,
  RecoveryNoteKey,
  RecoveryOperationFailure,
  RecoveryProbeRecord,
} from "./types";

export async function loadRecoveryNote(
  database: IDBDatabase,
  note: RecoveryNoteKey,
): Promise<RecoveryLoadResult> {
  const noteKey = recoveryNoteKey(note);
  if (noteKey === null) {
    return { kind: "invalid-input" };
  }
  try {
    const transaction = database.transaction(
      [ATTEMPTS_STORE, ACCOUNTING_STORE],
      "readonly",
    );
    const done = transactionDone(transaction);
    const index = transaction.objectStore(ATTEMPTS_STORE).index(NOTE_KEY_INDEX);
    const usagePromise = readByteUsage(transaction, noteKey);
    const values = await requestResult(
      index.getAll(noteKey) as IDBRequest<StoredAttempt[]>,
    );
    const usage = await usagePromise;
    await done;
    return validateLoadedRecords(values, usage.noteBytes);
  } catch (error) {
    return mapIndexedDbFailure(error);
  }
}

export async function getRecoveryByteUsage(
  database: IDBDatabase,
  note: RecoveryNoteKey,
): Promise<RecoveryByteUsage | RecoveryOperationFailure> {
  const noteKey = recoveryNoteKey(note);
  if (noteKey === null) {
    return { kind: "invalid-input" };
  }
  try {
    const transaction = database.transaction(ACCOUNTING_STORE, "readonly");
    const done = transactionDone(transaction);
    const usage = await readByteUsage(transaction, noteKey);
    await done;
    return usage;
  } catch (error) {
    return mapIndexedDbFailure(error);
  }
}

function validateLoadedRecords(
  values: readonly StoredAttempt[],
  expectedBytes: number,
): RecoveryLoadResult {
  const records: RecoveryProbeRecord[] = [];
  let actualBytes = 0;
  for (const value of values) {
    const validated = validateStoredAttempt(value);
    if (validated === null) {
      return { kind: "corrupt", recordKey: value.key };
    }
    records.push(validated.record);
    actualBytes += validated.stored.byteSize;
  }
  if (actualBytes !== expectedBytes) {
    return { kind: "corrupt", recordKey: "accounting" };
  }
  records.sort((left, right) => left.sessionOrder - right.sessionOrder);
  return { kind: "loaded", records };
}
