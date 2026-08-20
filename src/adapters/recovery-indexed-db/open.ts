import { requestResult, transactionDone } from "./idb-promises";
import {
  ACCOUNTING_STORE,
  ACTIVE_PREFIX_INDEX,
  BASE_DIGEST_INDEX,
  BASE_PATH_INDEX,
  BASE_REVISION_INDEX,
  CONFORMANCE_STORE,
  DATABASE_SCHEMA_VERSION,
  NOTE_KEY_INDEX,
  PREFIX_SCOPE_INDEX,
  PREFIX_PLAN_STORE,
  RELOCATION_ID_INDEX,
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
const CONFORMANCE_KEY_PREFIX = "atomicity-check:";
const COMMITTED_VALUE = "committed";
const ABORTED_VALUE = "aborted";
const CONFORMANCE_RANDOM_BYTES = 16;
const HEX_RADIX = 16;
const HEX_BYTE_WIDTH = 2;

interface RandomValuesCapability {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

export async function openIndexedDbRecoveryStore(
  options: IndexedDbRecoveryOptions = {},
): Promise<IndexedDbRecoveryOpenResult> {
  const factory = resolveFactory(options);
  if (factory === undefined) return unavailable();
  const conformanceKey = createConformanceKey();
  if (conformanceKey === null) return unavailable();
  const name = options.databaseName ?? DEFAULT_DATABASE_NAME;
  let database: IDBDatabase | undefined;
  try {
    database = await openDatabase(factory, name);
    if (
      !hasExpectedSchema(database) ||
      !(await verifiesAtomicity(database, conformanceKey))
    ) {
      database.close();
      return unavailable();
    }
    database.close();
    database = await openDatabase(factory, name);
    if (!(await verifiesRestartAndCleanup(database, conformanceKey))) {
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
    !database.objectStoreNames.contains(CONFORMANCE_STORE) ||
    !database.objectStoreNames.contains(PREFIX_PLAN_STORE)
  ) {
    return false;
  }
  const transaction = database.transaction(RECORDS_STORE, "readonly");
  const indices = transaction.objectStore(RECORDS_STORE).indexNames;
  const validRecordIndices = [
    NOTE_KEY_INDEX,
    SUCCESSOR_KEY_INDEX,
    BASE_PATH_INDEX,
    BASE_REVISION_INDEX,
    BASE_DIGEST_INDEX,
    SESSION_ORDER_INDEX,
    PREFIX_SCOPE_INDEX,
    ACTIVE_PREFIX_INDEX,
  ].every((name) => indices.contains(name));
  const planTransaction = database.transaction(PREFIX_PLAN_STORE, "readonly");
  return (
    validRecordIndices &&
    planTransaction
      .objectStore(PREFIX_PLAN_STORE)
      .indexNames.contains(RELOCATION_ID_INDEX)
  );
}

async function verifiesAtomicity(
  database: IDBDatabase,
  key: string,
): Promise<boolean> {
  try {
    await writeConformanceValue(database, key, COMMITTED_VALUE);
    const transaction = database.transaction(CONFORMANCE_STORE, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(CONFORMANCE_STORE).put(ABORTED_VALUE, key);
    transaction.abort();
    await done.catch(() => undefined);
    return (await readConformanceValue(database, key)) === COMMITTED_VALUE;
  } catch {
    return false;
  }
}

async function verifiesRestartAndCleanup(
  database: IDBDatabase,
  key: string,
): Promise<boolean> {
  try {
    if ((await readConformanceValue(database, key)) !== COMMITTED_VALUE)
      return false;
    const transaction = database.transaction(CONFORMANCE_STORE, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(CONFORMANCE_STORE).delete(key);
    await done;
    return (await readConformanceValue(database, key)) === undefined;
  } catch {
    return false;
  }
}

async function writeConformanceValue(
  database: IDBDatabase,
  key: string,
  value: string,
): Promise<void> {
  const transaction = database.transaction(CONFORMANCE_STORE, "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore(CONFORMANCE_STORE).put(value, key);
  await done;
}

async function readConformanceValue(
  database: IDBDatabase,
  key: string,
): Promise<unknown> {
  const transaction = database.transaction(CONFORMANCE_STORE, "readonly");
  const done = transactionDone(transaction);
  const value = await requestResult(
    transaction.objectStore(CONFORMANCE_STORE).get(key) as IDBRequest<unknown>,
  );
  await done;
  return value;
}

function createConformanceKey(): string | null {
  const candidate = Reflect.get(globalThis, "crypto") as unknown;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof Reflect.get(candidate, "getRandomValues") !== "function"
  ) {
    return null;
  }
  const crypto = candidate as RandomValuesCapability;
  try {
    const bytes = new Uint8Array(CONFORMANCE_RANDOM_BYTES);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes, (byte) =>
      byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, "0"),
    ).join("");
    return `${CONFORMANCE_KEY_PREFIX}${token}`;
  } catch {
    return null;
  }
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
