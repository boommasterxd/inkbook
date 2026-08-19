import type {
  PreparedForwardProbeRecord,
  RecoveryIndexedDbOptions,
  RecoveryIndexedDbProbeResult,
  RecoveryIndexedDbStore,
  RecoveryNoteKey,
} from "../../../src/adapters/recovery-indexed-db";
import { probeIndexedDbRecovery } from "../../../src/adapters/recovery-indexed-db";
import {
  RESOURCE_BUDGET_V1,
  ResourceCoordinatorV1,
} from "../../../src/application/resource-coordinator";

export const NOTE: RecoveryNoteKey = {
  vaultIdentityHint: "vault-fixture",
  markdownPath: "notes/example.md",
};

function createTestResourceCoordinator(): ResourceCoordinatorV1 {
  return new ResourceCoordinatorV1(RESOURCE_BUDGET_V1.desktopOrAndroidTablet);
}

export function probeRecovery(
  options: Omit<RecoveryIndexedDbOptions, "resourceCoordinator">,
  resourceCoordinator = createTestResourceCoordinator(),
): Promise<RecoveryIndexedDbProbeResult> {
  return probeIndexedDbRecovery({ ...options, resourceCoordinator });
}

export async function loadAndRelease(
  store: RecoveryIndexedDbStore,
  note: RecoveryNoteKey,
): Promise<
  | { readonly kind: "loaded"; readonly records: readonly unknown[] }
  | Exclude<
      Awaited<ReturnType<RecoveryIndexedDbStore["loadNote"]>>,
      { kind: "loaded" }
    >
> {
  const result = await store.loadNote(note);
  if (result.kind !== "loaded") return result;
  result.releaseResources();
  return { kind: result.kind, records: result.records };
}

export function preparedRecord(
  attemptId = "attempt-1",
  sessionOrder = 1,
  patch = "compact-patch",
): PreparedForwardProbeRecord {
  return {
    schemaVersion: 1,
    kind: "prepared-forward",
    note: NOTE,
    attemptId,
    sessionOrder,
    forwardPatch: `forward:${patch}`,
    inversePatch: `inverse:${patch}`,
  };
}

export function expectReady(
  result: RecoveryIndexedDbProbeResult,
): RecoveryIndexedDbStore {
  if (result.kind !== "ready") {
    throw new Error(`Expected ready probe, received ${result.reason}`);
  }
  return result.store;
}

export function openRawDatabase(
  factory: IDBFactory,
  name: string,
  version: number,
  upgrade?: (database: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, version);
    request.addEventListener("upgradeneeded", () => upgrade?.(request.result), {
      once: true,
    });
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener(
      "error",
      () =>
        reject(
          request.error ?? new DOMException("Open failed", "UnknownError"),
        ),
      { once: true },
    );
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () =>
        reject(transaction.error ?? new DOMException("Aborted", "AbortError")),
      { once: true },
    );
  });
}

export async function corruptFirstAttempt(
  database: IDBDatabase,
): Promise<void> {
  const transaction = database.transaction(
    ["attempts", "accounting"],
    "readwrite",
  );
  const completed = transactionComplete(transaction);
  const attempts = transaction.objectStore("attempts");
  const cursor = await requestValue(attempts.openCursor());
  if (cursor === null) {
    throw new Error("Expected an attempt to corrupt");
  }
  const value = cursor.value as Record<string, unknown>;
  cursor.update({ ...value, serialized: "{", byteSize: 1 });
  const noteKey = value.noteKey;
  if (typeof noteKey !== "string") {
    throw new Error("Expected a stored note key");
  }
  transaction
    .objectStore("accounting")
    .put({ key: `note:${noteKey}`, bytes: 1 });
  transaction.objectStore("accounting").put({ key: "global", bytes: 1 });
  await completed;
}

export function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener(
      "error",
      () =>
        reject(
          request.error ?? new DOMException("Request failed", "UnknownError"),
        ),
      { once: true },
    );
  });
}
