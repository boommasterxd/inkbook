import type { CommandResultV1 } from "../../application/note-session";
import type { RecoveryPersistenceRecordV1 } from "../../application/recovery";
import { requestResult, transactionDone } from "./idb-promises";
import { decodeStoredRecord } from "./record-storage";
import { RECORDS_STORE, type StoredRecoveryRecord } from "./schema";

export async function readRecordByKey(
  database: IDBDatabase,
  key: string,
): Promise<
  CommandResultV1<{
    stored: StoredRecoveryRecord;
    record: RecoveryPersistenceRecordV1;
  } | null>
> {
  try {
    const transaction = database.transaction(RECORDS_STORE, "readonly");
    const done = transactionDone(transaction);
    const value = await requestResult(
      transaction.objectStore(RECORDS_STORE).get(key) as IDBRequest<unknown>,
    );
    await done;
    if (value === undefined) return { ok: true, value: null };
    return await decodeStoredRecord(value, key);
  } catch {
    return { ok: false, code: "recovery-unavailable" };
  }
}
