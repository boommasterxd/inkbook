export const DATABASE_SCHEMA_VERSION = 2;
export const ATTEMPTS_STORE = "attempts";
export const ACCOUNTING_STORE = "accounting";
export const PROBE_STORE = "probe";
export const NOTE_KEY_INDEX = "noteKey";

export interface StoredAttempt {
  readonly key: string;
  readonly noteKey: string;
  readonly serialized: string;
  readonly byteSize: number;
}

export interface StoredAccounting {
  readonly key: string;
  readonly bytes: number;
}

export function upgradeRecoverySchema(event: IDBVersionChangeEvent): void {
  const request = event.target as IDBOpenDBRequest | null;
  if (request === null) {
    throw new TypeError("Invalid IndexedDB upgrade event target");
  }

  const database = request.result;
  if (event.oldVersion < 1) {
    const attempts = database.createObjectStore(ATTEMPTS_STORE, {
      keyPath: "key",
    });
    attempts.createIndex(NOTE_KEY_INDEX, NOTE_KEY_INDEX, { unique: false });
    database.createObjectStore(PROBE_STORE);
  }
  if (event.oldVersion < DATABASE_SCHEMA_VERSION) {
    database.createObjectStore(ACCOUNTING_STORE, { keyPath: "key" });
  }
}
