import { requestResult, transactionDone } from "./idb-promises";
import {
  ACCOUNTING_STORE,
  BASE_DIGEST_INDEX,
  BASE_PATH_INDEX,
  BASE_REVISION_INDEX,
  CONFORMANCE_STORE,
  DATABASE_SCHEMA_VERSION,
  NOTE_KEY_INDEX,
  PREFIX_SCOPE_INDEX,
  RECORDS_STORE,
  SESSION_ORDER_INDEX,
  SUCCESSOR_KEY_INDEX,
  upgradeRecoverySchema,
} from "./schema";
import { IndexedDbRecoveryStore } from "./store";
import type {
  IndexedDbRecoveryOpenResult,
  IndexedDbRecoveryOptions,
} from "./types";

const DEFAULT_DATABASE_NAME = "inkbook-recovery";
const CONFORMANCE_KEY = "atomicity-check";
const COMMITTED_VALUE = "committed";
const ABORTED_VALUE = "aborted";

export async function openIndexedDbRecoveryStore(
  options: IndexedDbRecoveryOptions = {},
): Promise<IndexedDbRecoveryOpenResult> {
  const factory = resolveFactory(options);
  if (factory === undefined) return unavailable();
  const name = options.databaseName ?? DEFAULT_DATABASE_NAME;
  let database: IDBDatabase | undefined;
  try {
    database = await openDatabase(factory, name);
    if (!hasExpectedSchema(database) || !(await verifiesAtomicity(database))) {
      database.close();
      return unavailable();
    }
    database.close();
    database = await openDatabase(factory, name);
    if (!(await verifiesRestartAndCleanup(database))) {
      database.close();
      return unavailable();
    }
    return {
      ok: true,
      value: new IndexedDbRecoveryStore(database, options),
    };
  } catch {
    database?.close();
    return unavailable();
  }
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, DATABASE_SCHEMA_VERSION);
    request.addEventListener("upgradeneeded", upgradeRecoverySchema);
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new DOMException("Open failed.")),
      { once: true },
    );
    request.addEventListener(
      "blocked",
      () => reject(new DOMException("Open blocked.", "InvalidStateError")),
      { once: true },
    );
  });
}

function hasExpectedSchema(database: IDBDatabase): boolean {
  if (
    !database.objectStoreNames.contains(RECORDS_STORE) ||
    !database.objectStoreNames.contains(ACCOUNTING_STORE) ||
    !database.objectStoreNames.contains(CONFORMANCE_STORE)
  ) {
    return false;
  }
  const transaction = database.transaction(RECORDS_STORE, "readonly");
  const indices = transaction.objectStore(RECORDS_STORE).indexNames;
  return [
    NOTE_KEY_INDEX,
    SUCCESSOR_KEY_INDEX,
    BASE_PATH_INDEX,
    BASE_REVISION_INDEX,
    BASE_DIGEST_INDEX,
    SESSION_ORDER_INDEX,
    PREFIX_SCOPE_INDEX,
  ].every((name) => indices.contains(name));
}

async function verifiesAtomicity(database: IDBDatabase): Promise<boolean> {
  try {
    await writeConformanceValue(database, COMMITTED_VALUE);
    const transaction = database.transaction(CONFORMANCE_STORE, "readwrite");
    const done = transactionDone(transaction);
    transaction
      .objectStore(CONFORMANCE_STORE)
      .put(ABORTED_VALUE, CONFORMANCE_KEY);
    transaction.abort();
    await done.catch(() => undefined);
    return (await readConformanceValue(database)) === COMMITTED_VALUE;
  } catch {
    return false;
  }
}

async function verifiesRestartAndCleanup(
  database: IDBDatabase,
): Promise<boolean> {
  try {
    if ((await readConformanceValue(database)) !== COMMITTED_VALUE)
      return false;
    const transaction = database.transaction(CONFORMANCE_STORE, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(CONFORMANCE_STORE).delete(CONFORMANCE_KEY);
    await done;
    return (await readConformanceValue(database)) === undefined;
  } catch {
    return false;
  }
}

async function writeConformanceValue(
  database: IDBDatabase,
  value: string,
): Promise<void> {
  const transaction = database.transaction(CONFORMANCE_STORE, "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore(CONFORMANCE_STORE).put(value, CONFORMANCE_KEY);
  await done;
}

async function readConformanceValue(database: IDBDatabase): Promise<unknown> {
  const transaction = database.transaction(CONFORMANCE_STORE, "readonly");
  const done = transactionDone(transaction);
  const value = await requestResult(
    transaction
      .objectStore(CONFORMANCE_STORE)
      .get(CONFORMANCE_KEY) as IDBRequest<unknown>,
  );
  await done;
  return value;
}

function resolveFactory(
  options: IndexedDbRecoveryOptions,
): IDBFactory | undefined {
  if (Object.prototype.hasOwnProperty.call(options, "indexedDb")) {
    return options.indexedDb;
  }
  const candidate = Reflect.get(globalThis, "indexedDB") as unknown;
  return isFactory(candidate) ? candidate : undefined;
}

function isFactory(value: unknown): value is IDBFactory {
  return (
    typeof value === "object" &&
    value !== null &&
    "open" in value &&
    typeof value.open === "function"
  );
}

function unavailable(): IndexedDbRecoveryOpenResult {
  return { ok: false, code: "recovery-unavailable" };
}
