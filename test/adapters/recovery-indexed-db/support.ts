import { IDBFactory } from "fake-indexeddb";

import {
  createHistoryEpoch,
  createHostTransactionSequence,
  createSessionOrder,
  createSettingsRevision,
  createSidecarRevision,
  createSourceGeneration,
  parseHostEffectId,
  parseRecoveryAttemptId,
  parseRelocationId,
  parseRemovalId,
  parseSha256Digest,
  parseSourceCheckpointId,
  parseViewId,
  type NoteIdentityV1,
} from "../../../src/application/note-session";
import {
  DATABASE_SCHEMA_VERSION,
  type IndexedDbRecoveryOpenResult,
  type IndexedDbRecoveryOptions,
  openIndexedDbRecoveryStore,
} from "../../../src/adapters/recovery-indexed-db";
import {
  type HostRecordedDirectionAttemptV1,
  type HostAcknowledgementV1,
  type FileRelocationRecordV1,
  type PreparedForwardAttemptV1,
  type PrefixRelocationRecordV1,
  type RecoveryLoadRequestV1,
  type RecoveryStore,
  type RemovalRecordV1,
  type SidecarBaseIdentityV1,
} from "../../../src/application/recovery";
import type { SourceCheckpointOperationV1 } from "../../../src/application/source-coordination";
import { createSceneRevision } from "../../../src/domain/model";
import { sha256Bytes } from "../../../src/domain/codecs/sha256";
import {
  parseHistoryEntryId,
  parseOperationId,
  type AnnotationPatchV1,
} from "../../../src/domain/operations";

/* eslint-disable @typescript-eslint/no-magic-numbers -- Persistence fixtures use exact revisions and counters. */

const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";
const PAYLOAD_LENGTH = 26;
const DIGEST_LENGTH = 64;

export const DIGEST_A = parseSha256Digest("a".repeat(DIGEST_LENGTH));
export const DIGEST_B = parseSha256Digest("b".repeat(DIGEST_LENGTH));
export const NOTE: NoteIdentityV1 = Object.freeze({
  vaultIdHint: "vault-fixture",
  vaultRelativeMarkdownPath: "notes/source.md",
});
export const BASE: SidecarBaseIdentityV1 = Object.freeze({
  markdownPath: NOTE.vaultRelativeMarkdownPath,
  rawTextSha256: DIGEST_A,
  revision: createSidecarRevision(1),
  vaultRelativePath: "notes/source.inkbook.json",
});
export const NEXT_BASE: SidecarBaseIdentityV1 = Object.freeze({
  ...BASE,
  rawTextSha256: DIGEST_B,
  revision: createSidecarRevision(2),
});

const FORWARD: AnnotationPatchV1 = Object.freeze({
  kind: "replace-note-appearance",
  prior: Object.freeze({
    background: "none",
    contrast: "medium",
    horizontalSpacing: "standard",
  }),
  replacement: Object.freeze({
    background: "ruled",
    contrast: "high",
    horizontalSpacing: "wide",
  }),
});
const INVERSE: AnnotationPatchV1 = Object.freeze({
  kind: "replace-note-appearance",
  prior: FORWARD.replacement,
  replacement: FORWARD.prior,
});

export function preparedAttempt(
  index = 1,
  sessionOrder = index,
  base: SidecarBaseIdentityV1 = BASE,
  expectedSceneRevision = 1,
): PreparedForwardAttemptV1 {
  const payload = idPayload(index);
  return {
    attemptId: parseRecoveryAttemptId(`ra_${payload}`),
    base,
    expectedSceneRevision: createSceneRevision(expectedSceneRevision),
    expectedSourceDigest: base === NEXT_BASE ? DIGEST_B : DIGEST_A,
    expectedSourceGeneration: createSourceGeneration(
      base === NEXT_BASE ? 2 : 1,
    ),
    forward: FORWARD,
    historyEntryId: parseHistoryEntryId(`he_${payload}`),
    historyEpoch: createHistoryEpoch(1),
    inverse: INVERSE,
    kind: "prepared-forward",
    operationId: parseOperationId(`op_${payload}`),
    sessionOrder: createSessionOrder(sessionOrder),
  };
}

export function directionAttempt(
  index: number,
  sessionOrder: number,
): HostRecordedDirectionAttemptV1 {
  const attempt = preparedAttempt(index, sessionOrder);
  return {
    ...commonAttempt(attempt),
    acknowledgement: hostAcknowledgement(index, "inverse"),
    directionPatch: INVERSE,
    kind: "host-recorded-undo",
  };
}

export function checkpoint(
  index = 1,
  sessionOrder = 2,
): SourceCheckpointOperationV1 {
  return {
    base: BASE,
    checkpointId: parseSourceCheckpointId(`scp_${idPayload(index)}`),
    offsetMap: {
      spans: [
        {
          newFromUtf16: 1,
          newToUtf16: 2,
          oldFromUtf16: 1,
          oldToUtf16: 1,
        },
      ],
    },
    priorDigest: DIGEST_A,
    priorGeneration: createSourceGeneration(1),
    priorUtf16Length: 4,
    replacementDigest: DIGEST_B,
    replacementGeneration: createSourceGeneration(2),
    replacementUtf16Length: 5,
    sessionOrder: createSessionOrder(sessionOrder),
  } as const;
}

export function hostAcknowledgement(
  index = 1,
  direction: "forward" | "inverse" = "forward",
): HostAcknowledgementV1 {
  return {
    direction,
    editorViewId: parseViewId(`view-${String(index)}`),
    effectId: parseHostEffectId(`eff_${idPayload(index)}`),
    transactionSequence: createHostTransactionSequence(index),
  } as const;
}

export function existingLoad(
  base: SidecarBaseIdentityV1 = BASE,
  digest = DIGEST_A,
  length = 4,
): RecoveryLoadRequestV1 {
  return {
    base,
    currentMarkdownDigest: digest,
    currentMarkdownUtf16Length: length,
    kind: "existing-sidecar",
    noteIdentity: {
      ...NOTE,
      vaultRelativeMarkdownPath: base.markdownPath,
    },
    validatedSidecarSourceDigest: digest,
    validatedSidecarSourceGeneration: createSourceGeneration(
      digest === DIGEST_B ? 2 : 1,
    ),
  };
}

export function fileRelocation(
  step: FileRelocationRecordV1["step"] = "prepared",
): FileRelocationRecordV1 {
  return {
    destinationMarkdownPath: "notes/destination.md",
    destinationSidecarPath: "notes/destination.inkbook.json",
    expectedSceneRevision: createSceneRevision(1),
    expectedSettingsRevision: createSettingsRevision(1),
    kind: "markdown-file",
    noteIdentity: NOTE,
    relocationId: parseRelocationId(`rel_${idPayload(1)}`),
    sidecarBase: BASE,
    sourceMarkdownPath: NOTE.vaultRelativeMarkdownPath,
    sourceSidecarPath: BASE.vaultRelativePath,
    step,
  };
}

export function prefixRelocation(): PrefixRelocationRecordV1 {
  return {
    admittedRecordCount: 0,
    cursor: 0,
    expectedSettingsRevision: createSettingsRevision(1),
    generation: 1,
    kind: "folder-prefix",
    priorPrefix: "notes",
    relocationId: parseRelocationId(`rel_${idPayload(2)}`),
    replacementPrefix: "archive",
    step: "prepared",
  };
}

export function removal(
  overrides: Partial<RemovalRecordV1> = {},
): RemovalRecordV1 {
  return {
    deadlineEpochMs: 1,
    deleteEventAcknowledged: false,
    expectedSceneRevision: createSceneRevision(1),
    kind: "annotation-removal",
    markerState: "present",
    noteIdentity: NOTE,
    removalId: parseRemovalId(`rm_${idPayload(1)}`),
    sidecarBase: BASE,
    trashAcknowledged: false,
    ...overrides,
  };
}

export async function openStore(
  databaseName: string,
  options: Omit<IndexedDbRecoveryOptions, "databaseName" | "indexedDb"> = {},
  factory = new IDBFactory(),
): Promise<{ store: RecoveryStore; factory: IDBFactory }> {
  const result = await openIndexedDbRecoveryStore({
    ...options,
    databaseName,
    indexedDb: factory,
  });
  return { store: expectOpen(result), factory };
}

function expectOpen(result: IndexedDbRecoveryOpenResult): RecoveryStore {
  if (!result.ok)
    throw new Error(`Expected a recovery store, got ${result.code}.`);
  return result.value;
}

export function idPayload(value: number): string {
  let remaining = value;
  let encoded = "";
  do {
    encoded = `${BASE32[remaining % BASE32.length] ?? ""}${encoded}`;
    remaining = Math.floor(remaining / BASE32.length);
  } while (remaining > 0);
  return encoded.padStart(PAYLOAD_LENGTH, "0");
}

export function openRawDatabase(
  factory: IDBFactory,
  name: string,
  version: number,
  upgrade?: (database: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, version);
    request.addEventListener("upgradeneeded", () => upgrade?.(request.result));
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new DOMException("Open failed.")),
    );
  });
}

export async function corruptStoredRecord(
  factory: IDBFactory,
  databaseName: string,
  key: string,
): Promise<void> {
  await updateStoredRecord(factory, databaseName, key, (value) => ({
    ...value,
    encoded: new Uint8Array([123]),
  }));
}

export async function corruptStoredSha256(
  factory: IDBFactory,
  databaseName: string,
  key: string,
): Promise<void> {
  await updateStoredRecord(factory, databaseName, key, (value) => ({
    ...value,
    sha256: "0".repeat(DIGEST_LENGTH),
  }));
}

export async function replaceStoredEncoded(
  factory: IDBFactory,
  databaseName: string,
  key: string,
  encoded: Uint8Array,
): Promise<void> {
  const sha256 = await sha256Bytes(encoded);
  await updateStoredRecord(factory, databaseName, key, (value) => {
    if (value.byteSize !== encoded.byteLength) {
      throw new Error("Replacement fixture must preserve accounting bytes.");
    }
    return { ...value, encoded, sha256 };
  });
}

export async function replaceStoredEncodedKeepingSha256(
  factory: IDBFactory,
  databaseName: string,
  key: string,
  encoded: Uint8Array,
): Promise<void> {
  await updateStoredRecord(factory, databaseName, key, (value) => {
    if (value.byteSize !== encoded.byteLength) {
      throw new Error("Replacement fixture must preserve accounting bytes.");
    }
    return { ...value, encoded };
  });
}

async function updateStoredRecord(
  factory: IDBFactory,
  databaseName: string,
  key: string,
  update: (value: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const database = await openRawDatabase(
    factory,
    databaseName,
    DATABASE_SCHEMA_VERSION,
  );
  const transaction = database.transaction("records", "readwrite");
  const done = transactionComplete(transaction);
  const store = transaction.objectStore("records");
  const value = await requestValue(store.get(key) as IDBRequest<unknown>);
  if (typeof value !== "object" || value === null) {
    throw new Error("Expected a stored recovery record.");
  }
  store.put(update(value as Record<string, unknown>));
  await done;
  database.close();
}

function commonAttempt(
  attempt: PreparedForwardAttemptV1,
): Omit<PreparedForwardAttemptV1, "forward" | "inverse" | "kind"> {
  return {
    attemptId: attempt.attemptId,
    base: attempt.base,
    expectedSceneRevision: attempt.expectedSceneRevision,
    expectedSourceDigest: attempt.expectedSourceDigest,
    expectedSourceGeneration: attempt.expectedSourceGeneration,
    historyEntryId: attempt.historyEntryId,
    historyEpoch: attempt.historyEpoch,
    operationId: attempt.operationId,
    sessionOrder: attempt.sessionOrder,
  };
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new DOMException("Request failed.")),
    );
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new DOMException("Transaction aborted.")),
    );
  });
}
