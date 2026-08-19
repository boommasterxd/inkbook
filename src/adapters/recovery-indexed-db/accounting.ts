import { requestResult } from "./idb-promises";
import { ACCOUNTING_STORE, type StoredAccounting } from "./schema";
import type { RecoveryByteUsage } from "./types";

const GLOBAL_ACCOUNTING_KEY = "global";
const NOTE_ACCOUNTING_PREFIX = "note:";
const SESSION_ORDER_PREFIX = "session-order:";

export async function readByteUsage(
  transaction: IDBTransaction,
  noteKey: string,
): Promise<RecoveryByteUsage> {
  const store = transaction.objectStore(ACCOUNTING_STORE);
  const [global, note] = await Promise.all([
    readAccounting(store, GLOBAL_ACCOUNTING_KEY),
    readAccounting(store, noteAccountingKey(noteKey)),
  ]);
  return {
    globalBytes: global?.bytes ?? 0,
    noteBytes: note?.bytes ?? 0,
  };
}

export function writeByteUsage(
  transaction: IDBTransaction,
  noteKey: string,
  usage: RecoveryByteUsage,
): void {
  const store = transaction.objectStore(ACCOUNTING_STORE);
  store.put({ key: GLOBAL_ACCOUNTING_KEY, bytes: usage.globalBytes });
  if (usage.noteBytes === 0) {
    store.delete(noteAccountingKey(noteKey));
    return;
  }
  store.put({ key: noteAccountingKey(noteKey), bytes: usage.noteBytes });
}

export function addBytes(
  usage: RecoveryByteUsage,
  delta: number,
): RecoveryByteUsage | null {
  const globalBytes = usage.globalBytes + delta;
  const noteBytes = usage.noteBytes + delta;
  if (globalBytes < 0 || noteBytes < 0) {
    return null;
  }
  return { globalBytes, noteBytes };
}

export async function readSessionOrderHighWater(
  transaction: IDBTransaction,
  noteKey: string,
): Promise<number> {
  const value = await readAccounting(
    transaction.objectStore(ACCOUNTING_STORE),
    sessionOrderKey(noteKey),
  );
  return value?.bytes ?? 0;
}

export function writeSessionOrderHighWater(
  transaction: IDBTransaction,
  noteKey: string,
  sessionOrder: number,
): void {
  transaction
    .objectStore(ACCOUNTING_STORE)
    .put({ key: sessionOrderKey(noteKey), bytes: sessionOrder });
}

function noteAccountingKey(noteKey: string): string {
  return `${NOTE_ACCOUNTING_PREFIX}${noteKey}`;
}

function sessionOrderKey(noteKey: string): string {
  return `${SESSION_ORDER_PREFIX}${noteKey}`;
}

async function readAccounting(
  store: IDBObjectStore,
  key: string,
): Promise<StoredAccounting | undefined> {
  const value = await requestResult(store.get(key) as IDBRequest<unknown>);
  if (value === undefined) {
    return undefined;
  }
  if (!isValidAccounting(value, key)) {
    throw new DOMException("Recovery accounting is corrupt", "DataError");
  }
  return value;
}

function isValidAccounting(
  value: unknown,
  expectedKey: string,
): value is StoredAccounting {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .join(",") === "bytes,key" &&
    "key" in value &&
    value.key === expectedKey &&
    "bytes" in value &&
    typeof value.bytes === "number" &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0
  );
}
