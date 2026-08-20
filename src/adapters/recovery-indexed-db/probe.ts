import { isSchemaVersionError } from "./error-mapping";
import { requestResult, transactionDone } from "./idb-promises";
import {
  ACCOUNTING_STORE,
  ATTEMPTS_STORE,
  DATABASE_SCHEMA_VERSION,
  NOTE_KEY_INDEX,
  PROBE_STORE,
  upgradeRecoverySchema,
} from "./schema";
import { IndexedDbRecoveryStore } from "./store";
import type {
  RecoveryIndexedDbOptions,
  RecoveryIndexedDbProbeResult,
  RecoveryProbeFailureReason,
} from "./types";

const DEFAULT_DATABASE_NAME = "inkbook-recovery";
const PROBE_KEY = "phase-zero-conformance";
const COMMITTED_VALUE = "committed";
const ABORTED_VALUE = "aborted";

export async function probeIndexedDbRecovery(
  options: RecoveryIndexedDbOptions = {},
): Promise<RecoveryIndexedDbProbeResult> {
  const factory = options.indexedDb ?? getGlobalIndexedDb();
  if (factory === undefined) {
    return readOnly("backend-unavailable");
  }
  const databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
  let database: IDBDatabase | undefined;
  try {
    database = await openDatabase(factory, databaseName);
    if (!hasExpectedSchema(database)) {
      database.close();
      return readOnly("schema-incompatible");
    }
    if (!(await provesTransactions(database))) {
      database.close();
      return readOnly("non-transactional");
    }
    database.close();
    database = await openDatabase(factory, databaseName);
    if (!(await provesRestartAndCleanup(database))) {
      database.close();
      return readOnly("non-transactional");
    }
    return {
      kind: "ready",
      store: new IndexedDbRecoveryStore(database, options),
    };
  } catch (error) {
    database?.close();
    return readOnly(
      isSchemaVersionError(error)
        ? "schema-incompatible"
        : "backend-unavailable",
    );
  }
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, DATABASE_SCHEMA_VERSION);
    let settled = false;
    request.addEventListener("upgradeneeded", upgradeRecoverySchema);
    request.addEventListener(
      "success",
      () => {
        if (settled) {
          request.result.close();
          return;
        }
        settled = true;
        resolve(request.result);
      },
      { once: true },
    );
    request.addEventListener(
      "error",
      () => {
        settled = true;
        reject(
          request.error ??
            new DOMException("IndexedDB open failed", "UnknownError"),
        );
      },
      { once: true },
    );
    request.addEventListener(
      "blocked",
      () => {
        settled = true;
        reject(
          new DOMException("IndexedDB open was blocked", "InvalidStateError"),
        );
      },
      { once: true },
    );
  });
}

function hasExpectedSchema(database: IDBDatabase): boolean {
  if (
    !database.objectStoreNames.contains(ATTEMPTS_STORE) ||
    !database.objectStoreNames.contains(ACCOUNTING_STORE) ||
    !database.objectStoreNames.contains(PROBE_STORE)
  ) {
    return false;
  }
  const transaction = database.transaction(ATTEMPTS_STORE, "readonly");
  return transaction
    .objectStore(ATTEMPTS_STORE)
    .indexNames.contains(NOTE_KEY_INDEX);
}

async function provesTransactions(database: IDBDatabase): Promise<boolean> {
  try {
    await writeProbeValue(database, COMMITTED_VALUE);
    const abortTransaction = database.transaction(PROBE_STORE, "readwrite");
    const aborted = transactionDone(abortTransaction);
    abortTransaction.objectStore(PROBE_STORE).put(ABORTED_VALUE, PROBE_KEY);
    abortTransaction.abort();
    await aborted.catch(() => undefined);
    return (await readProbeValue(database)) === COMMITTED_VALUE;
  } catch {
    return false;
  }
}

async function provesRestartAndCleanup(
  database: IDBDatabase,
): Promise<boolean> {
  try {
    if ((await readProbeValue(database)) !== COMMITTED_VALUE) {
      return false;
    }
    const transaction = database.transaction(PROBE_STORE, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(PROBE_STORE).delete(PROBE_KEY);
    await done;
    return (await readProbeValue(database)) === undefined;
  } catch {
    return false;
  }
}

async function writeProbeValue(
  database: IDBDatabase,
  value: string,
): Promise<void> {
  const transaction = database.transaction(PROBE_STORE, "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore(PROBE_STORE).put(value, PROBE_KEY);
  await done;
}

async function readProbeValue(database: IDBDatabase): Promise<unknown> {
  const transaction = database.transaction(PROBE_STORE, "readonly");
  const done = transactionDone(transaction);
  const value = await requestResult(
    transaction.objectStore(PROBE_STORE).get(PROBE_KEY) as IDBRequest<unknown>,
  );
  await done;
  return value;
}

function getGlobalIndexedDb(): IDBFactory | undefined {
  const candidate = Reflect.get(globalThis, "indexedDB") as unknown;
  return isIndexedDbFactory(candidate) ? candidate : undefined;
}

function isIndexedDbFactory(value: unknown): value is IDBFactory {
  return (
    typeof value === "object" &&
    value !== null &&
    "open" in value &&
    typeof value.open === "function" &&
    "deleteDatabase" in value &&
    typeof value.deleteDatabase === "function"
  );
}

function readOnly(
  reason: RecoveryProbeFailureReason,
): RecoveryIndexedDbProbeResult {
  return { kind: "read-only", reason };
}
