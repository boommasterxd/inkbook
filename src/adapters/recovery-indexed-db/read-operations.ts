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
  RecoveryNoteKey,
  RecoveryOperationFailure,
  RecoveryProbeRecord,
} from "./types";

export type RecoveryLoadDataResult =
  | {
      readonly kind: "loaded";
      readonly records: readonly RecoveryProbeRecord[];
    }
  | { readonly kind: "corrupt"; readonly recordKey: string }
  | RecoveryOperationFailure;

export interface RecoveryTransactionObserver {
  finish(transaction: IDBTransaction): void;
  start(transaction: IDBTransaction): void;
}

export async function loadRecoveryNote(
  database: IDBDatabase,
  note: RecoveryNoteKey,
  observer: RecoveryTransactionObserver,
): Promise<RecoveryLoadDataResult> {
  const noteKey = recoveryNoteKey(note);
  if (noteKey === null) {
    return { kind: "invalid-input" };
  }
  let transaction: IDBTransaction | undefined;
  try {
    transaction = database.transaction(
      [ATTEMPTS_STORE, ACCOUNTING_STORE],
      "readonly",
    );
    observer.start(transaction);
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
  } finally {
    if (transaction !== undefined) observer.finish(transaction);
  }
}

export async function getRecoveryByteUsage(
  database: IDBDatabase,
  note: RecoveryNoteKey,
  observer: RecoveryTransactionObserver,
): Promise<RecoveryByteUsage | RecoveryOperationFailure> {
  const noteKey = recoveryNoteKey(note);
  if (noteKey === null) {
    return { kind: "invalid-input" };
  }
  let transaction: IDBTransaction | undefined;
  try {
    transaction = database.transaction(ACCOUNTING_STORE, "readonly");
    observer.start(transaction);
    const done = transactionDone(transaction);
    const usage = await readByteUsage(transaction, noteKey);
    await done;
    return usage;
  } catch (error) {
    return mapIndexedDbFailure(error);
  } finally {
    if (transaction !== undefined) observer.finish(transaction);
  }
}

function validateLoadedRecords(
  values: readonly StoredAttempt[],
  expectedBytes: number,
): RecoveryLoadDataResult {
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
