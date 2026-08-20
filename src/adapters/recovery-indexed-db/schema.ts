export const DATABASE_SCHEMA_VERSION = 3;
export const RECORDS_STORE = "records";
export const ACCOUNTING_STORE = "accounting";
export const CONFORMANCE_STORE = "conformance";

export const NOTE_KEY_INDEX = "noteKey";
export const SUCCESSOR_KEY_INDEX = "successorKey";
export const BASE_PATH_INDEX = "basePath";
export const BASE_REVISION_INDEX = "baseRevision";
export const BASE_DIGEST_INDEX = "baseDigest";
export const SESSION_ORDER_INDEX = "noteSessionOrder";
export const PREFIX_SCOPE_INDEX = "prefixScopes";

export type StoredRecordKind =
  "attempt" | "checkpoint" | "relocation" | "removal";

export interface StoredRecoveryRecord {
  readonly key: string;
  readonly kind: StoredRecordKind;
  readonly noteKey: string | null;
  readonly successorKey: string | null;
  readonly basePath: string | null;
  readonly baseRevision: number;
  readonly baseDigest: string;
  readonly sessionOrder: number;
  readonly noteSessionOrder: readonly [string, number] | null;
  readonly prefixScopes: readonly string[];
  readonly encoded: Uint8Array;
  readonly byteSize: number;
  readonly sha256: string;
}

export interface StoredAccounting {
  readonly key: string;
  readonly bytes: number;
  readonly records: number;
  readonly sessionOrderHighWater: number;
}

export function upgradeRecoverySchema(event: IDBVersionChangeEvent): void {
  const request = event.target as IDBOpenDBRequest | null;
  if (request === null) {
    throw new TypeError("Invalid IndexedDB upgrade event target.");
  }
  const database = request.result;
  if (event.oldVersion < DATABASE_SCHEMA_VERSION) {
    for (const name of Array.from(database.objectStoreNames)) {
      database.deleteObjectStore(name);
    }
    createRecoveryStores(database);
  }
}

function createRecoveryStores(database: IDBDatabase): void {
  const records = database.createObjectStore(RECORDS_STORE, { keyPath: "key" });
  records.createIndex(NOTE_KEY_INDEX, NOTE_KEY_INDEX, { unique: false });
  records.createIndex(SUCCESSOR_KEY_INDEX, SUCCESSOR_KEY_INDEX, {
    unique: false,
  });
  records.createIndex(BASE_PATH_INDEX, BASE_PATH_INDEX, { unique: false });
  records.createIndex(BASE_REVISION_INDEX, BASE_REVISION_INDEX, {
    unique: false,
  });
  records.createIndex(BASE_DIGEST_INDEX, BASE_DIGEST_INDEX, { unique: false });
  records.createIndex(SESSION_ORDER_INDEX, SESSION_ORDER_INDEX, {
    unique: false,
  });
  records.createIndex(PREFIX_SCOPE_INDEX, PREFIX_SCOPE_INDEX, {
    multiEntry: true,
    unique: false,
  });
  database.createObjectStore(ACCOUNTING_STORE, { keyPath: "key" });
  database.createObjectStore(CONFORMANCE_STORE);
}
