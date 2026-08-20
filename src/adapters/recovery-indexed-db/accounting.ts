import { requestResult } from "./idb-promises";
import { ACCOUNTING_STORE, type StoredAccounting } from "./schema";
import type { RecoveryAccounting } from "./types";

const GLOBAL_KEY = "global";
const NOTE_PREFIX = "note:";
const ACCOUNTING_KEYS = [
  "bytes",
  "key",
  "records",
  "sessionOrderHighWater",
] as const;
const EMPTY_ACCOUNTING: RecoveryAccounting = Object.freeze({
  bytes: 0,
  records: 0,
  sessionOrderHighWater: 0,
});

export async function readAccounting(
  transaction: IDBTransaction,
  noteKey: string | null,
): Promise<{ global: RecoveryAccounting; note: RecoveryAccounting }> {
  const store = transaction.objectStore(ACCOUNTING_STORE);
  const [global, note] = await Promise.all([
    readEntry(store, GLOBAL_KEY),
    noteKey === null ? undefined : readEntry(store, noteAccountingKey(noteKey)),
  ]);
  return {
    global: global ?? EMPTY_ACCOUNTING,
    note: note ?? EMPTY_ACCOUNTING,
  };
}

export function writeAccounting(
  transaction: IDBTransaction,
  noteKey: string | null,
  accounting: { global: RecoveryAccounting; note: RecoveryAccounting },
): void {
  const store = transaction.objectStore(ACCOUNTING_STORE);
  store.put(toStored(GLOBAL_KEY, accounting.global));
  if (noteKey === null) return;
  const key = noteAccountingKey(noteKey);
  if (
    accounting.note.bytes === 0 &&
    accounting.note.records === 0 &&
    accounting.note.sessionOrderHighWater === 0
  ) {
    store.delete(key);
    return;
  }
  store.put(toStored(key, accounting.note));
}

export function applyAccountingDelta(
  accounting: { global: RecoveryAccounting; note: RecoveryAccounting },
  byteDelta: number,
  recordDelta: number,
  sessionOrder?: number,
  applyToNote = true,
): { global: RecoveryAccounting; note: RecoveryAccounting } | null {
  const global = applyDelta(accounting.global, byteDelta, recordDelta);
  const note = applyToNote
    ? applyDelta(accounting.note, byteDelta, recordDelta, sessionOrder)
    : accounting.note;
  return global === null || note === null ? null : { global, note };
}

function noteAccountingKey(noteKey: string): string {
  return `${NOTE_PREFIX}${noteKey}`;
}

export async function readNoteAccounting(
  transaction: IDBTransaction,
  noteKey: string,
): Promise<RecoveryAccounting> {
  return (
    (await readEntry(
      transaction.objectStore(ACCOUNTING_STORE),
      noteAccountingKey(noteKey),
    )) ?? EMPTY_ACCOUNTING
  );
}

function applyDelta(
  current: RecoveryAccounting,
  byteDelta: number,
  recordDelta: number,
  sessionOrder?: number,
): RecoveryAccounting | null {
  const bytes = current.bytes + byteDelta;
  const records = current.records + recordDelta;
  if (!validCounter(bytes) || !validCounter(records)) return null;
  return {
    bytes,
    records,
    sessionOrderHighWater:
      sessionOrder === undefined
        ? current.sessionOrderHighWater
        : Math.max(current.sessionOrderHighWater, sessionOrder),
  };
}

async function readEntry(
  store: IDBObjectStore,
  key: string,
): Promise<RecoveryAccounting | undefined> {
  const value = await requestResult(store.get(key) as IDBRequest<unknown>);
  if (value === undefined) return undefined;
  if (!isStoredAccounting(value, key)) {
    throw new DOMException("Recovery accounting is corrupt.", "DataError");
  }
  return {
    bytes: value.bytes,
    records: value.records,
    sessionOrderHighWater: value.sessionOrderHighWater,
  };
}

function toStored(key: string, value: RecoveryAccounting): StoredAccounting {
  return { key, ...value };
}

function isStoredAccounting(
  value: unknown,
  expectedKey: string,
): value is StoredAccounting {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<StoredAccounting>;
  return (
    hasExactKeys(value, ACCOUNTING_KEYS) &&
    candidate.key === expectedKey &&
    validCounter(candidate.bytes) &&
    validCounter(candidate.records) &&
    validCounter(candidate.sessionOrderHighWater)
  );
}

function validCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort((left, right) =>
    left.localeCompare(right),
  );
  const sorted = [...expected].sort((left, right) => left.localeCompare(right));
  return (
    keys.length === sorted.length &&
    keys.every((key, index) => key === sorted[index])
  );
}
