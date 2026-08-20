import type { CommandResultV1 } from "../../application/note-session";
import {
  applyAccountingDelta,
  readAccounting,
  writeAccounting,
} from "./accounting";
import { requestResult } from "./idb-promises";
import { bytesEqual, decodeStoredRecordInTransaction } from "./record-storage";
import {
  RECORDS_STORE,
  SUCCESSOR_KEY_INDEX,
  type StoredRecoveryRecord,
} from "./schema";
import type { IndexedDbRecoveryLimits } from "./types";

export async function insertRecord(
  transaction: IDBTransaction,
  stored: StoredRecoveryRecord,
  limits: IndexedDbRecoveryLimits,
): Promise<CommandResultV1<void>> {
  const records = transaction.objectStore(RECORDS_STORE);
  const existing = await requestResult(
    records.get(stored.key) as IDBRequest<unknown>,
  );
  if (existing !== undefined) return compareExisting(existing, stored);
  const accounting = await readAccounting(transaction, stored.noteKey);
  if (
    stored.sessionOrder > 0 &&
    stored.sessionOrder <= accounting.note.sessionOrderHighWater
  ) {
    return conflict();
  }
  if (!(await hasSuccessorCapacity(records, stored, limits))) return limited();
  const replacement = applyAccountingDelta(
    accounting,
    stored.byteSize,
    1,
    stored.sessionOrder > 0 ? stored.sessionOrder : undefined,
    stored.noteKey !== null,
  );
  if (replacement === null || exceedsLimits(replacement, limits)) {
    return limited();
  }
  records.put(stored);
  writeAccounting(transaction, stored.noteKey, replacement);
  return success();
}

export async function replaceRecord(
  transaction: IDBTransaction,
  prior: StoredRecoveryRecord,
  replacement: StoredRecoveryRecord,
  limits: IndexedDbRecoveryLimits,
): Promise<CommandResultV1<void>> {
  const accounting = await readAccounting(transaction, prior.noteKey);
  const adjusted = applyAccountingDelta(
    accounting,
    replacement.byteSize - prior.byteSize,
    0,
    undefined,
    prior.noteKey !== null,
  );
  if (adjusted === null || exceedsLimits(adjusted, limits)) return limited();
  transaction.objectStore(RECORDS_STORE).put(replacement);
  writeAccounting(transaction, prior.noteKey, adjusted);
  return success();
}

export function exceedsLimits(
  accounting: Awaited<ReturnType<typeof readAccounting>>,
  limits: IndexedDbRecoveryLimits,
): boolean {
  return (
    accounting.global.bytes > limits.globalBytes ||
    accounting.global.records > limits.globalRecords ||
    accounting.note.bytes > limits.noteBytes ||
    accounting.note.records > limits.noteRecords
  );
}

async function hasSuccessorCapacity(
  records: IDBObjectStore,
  stored: StoredRecoveryRecord,
  limits: IndexedDbRecoveryLimits,
): Promise<boolean> {
  if (stored.successorKey === null) return true;
  const count = await requestResult(
    records.index(SUCCESSOR_KEY_INDEX).count(stored.successorKey),
  );
  return count < limits.directSuccessors;
}

function compareExisting(
  value: unknown,
  candidate: StoredRecoveryRecord,
): CommandResultV1<void> {
  const decoded = decodeStoredRecordInTransaction(value, candidate.key);
  if (!decoded.ok) return decoded;
  if (!bytesEqual(decoded.value.stored.encoded, candidate.encoded)) {
    return conflict();
  }
  return decoded.value.stored.sha256 === candidate.sha256
    ? success()
    : { ok: false, code: "recovery-unavailable" };
}

export function success(): CommandResultV1<void> {
  return { ok: true, value: undefined };
}

export function conflict(): CommandResultV1<never> {
  return { ok: false, code: "sidecar-conflict" };
}

export function limited(): CommandResultV1<never> {
  return { ok: false, code: "recovery-limit" };
}
