import {
  decodeRecoveryRecordV1,
  encodeRecoveryRecordV1,
  type PrefixRelocationRecordV1,
  type RecoveryPersistenceRecordV1,
  type SidecarBaseIdentityV1,
} from "../../application/recovery";
import { sha256Bytes } from "../../domain/codecs/sha256";
import type { CommandResultV1 } from "../../application/note-session";
import type { StoredRecoveryRecord, StoredRecordKind } from "./schema";
import { parseStoredRecord } from "./stored-record-validation";

const NULL_REVISION = -1;
const EMPTY_DIGEST = "";

export async function createStoredRecord(
  record: RecoveryPersistenceRecordV1,
  admittedBytes?: Uint8Array,
): Promise<CommandResultV1<StoredRecoveryRecord>> {
  const encoded =
    admittedBytes === undefined
      ? encodeRecoveryRecordV1(record)
      : { ok: true as const, value: admittedBytes };
  if (!encoded.ok) return encoded;
  const identity = recordIdentity(record);
  const base = recordBase(record);
  const noteKey = recordNoteKey(record);
  const sessionOrder = recordSessionOrder(record);
  const successorKey =
    base === null || noteKey === null
      ? null
      : recoverySuccessorKey(noteKey, base);
  return {
    ok: true,
    value: {
      activePrefixRelocation: isPrefixRelocation(record) ? "active" : null,
      baseDigest: base?.rawTextSha256 ?? EMPTY_DIGEST,
      basePath: base?.vaultRelativePath ?? null,
      baseRevision: base?.revision ?? NULL_REVISION,
      byteSize: encoded.value.byteLength,
      encoded: encoded.value,
      key: `${identity.kind}:${identity.id}`,
      kind: identity.kind,
      noteKey,
      noteSessionOrder:
        noteKey === null || sessionOrder === 0 ? null : [noteKey, sessionOrder],
      prefixScopes: prefixScopes(record),
      sessionOrder,
      sha256: await sha256Bytes(encoded.value),
      successorKey,
    },
  };
}

export async function decodeStoredRecord(
  value: unknown,
  expectedKey?: string,
): Promise<
  CommandResultV1<{
    stored: StoredRecoveryRecord;
    record: RecoveryPersistenceRecordV1;
  }>
> {
  const stored = parseStoredRecord(value, expectedKey);
  if (stored === null) return { ok: false, code: "recovery-unavailable" };
  const decoded = decodeRecoveryRecordV1(stored.encoded);
  if (!decoded.ok) return { ok: false, code: "recovery-unavailable" };
  const rebuilt = await createStoredRecord(decoded.value);
  const expected =
    rebuilt.ok && stored.activePrefixRelocation === "retained"
      ? retainCompletedPrefixRecord(rebuilt.value, decoded.value)
      : rebuilt;
  if (!expected.ok || !sameStoredRecord(stored, expected.value)) {
    return { ok: false, code: "recovery-unavailable" };
  }
  return { ok: true, value: { stored, record: decoded.value } };
}

export function decodeStoredRecordInTransaction(
  value: unknown,
  expectedKey?: string,
): CommandResultV1<{
  stored: StoredRecoveryRecord;
  record: RecoveryPersistenceRecordV1;
}> {
  const stored = parseStoredRecord(value, expectedKey);
  if (stored === null) return { ok: false, code: "recovery-unavailable" };
  const decoded = decodeRecoveryRecordV1(stored.encoded);
  if (!decoded.ok || !metadataMatchesRecord(stored, decoded.value)) {
    return { ok: false, code: "recovery-unavailable" };
  }
  return { ok: true, value: { stored, record: decoded.value } };
}

function recordKey(record: RecoveryPersistenceRecordV1): string {
  const identity = recordIdentity(record);
  return `${identity.kind}:${identity.id}`;
}

export function recoverySuccessorKey(
  noteKey: string,
  base: SidecarBaseIdentityV1,
): string {
  return JSON.stringify([
    noteKey,
    base.vaultRelativePath,
    base.revision,
    base.rawTextSha256,
    base.markdownPath,
  ]);
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

export function storedPayloadEqual(
  left: StoredRecoveryRecord,
  right: StoredRecoveryRecord,
): boolean {
  return (
    left.sha256 === right.sha256 && bytesEqual(left.encoded, right.encoded)
  );
}

export function retainCompletedPrefixRecord(
  stored: StoredRecoveryRecord,
  record: RecoveryPersistenceRecordV1,
): CommandResultV1<StoredRecoveryRecord> {
  if (!isPrefixRelocation(record) || record.step !== "complete") {
    return { ok: false, code: "sidecar-conflict" };
  }
  return {
    ok: true,
    value: {
      ...stored,
      activePrefixRelocation: "retained",
      prefixScopes: Object.freeze([]),
    },
  };
}

function recordIdentity(record: RecoveryPersistenceRecordV1): {
  kind: StoredRecordKind;
  id: string;
} {
  if ("attemptId" in record) return { kind: "attempt", id: record.attemptId };
  if ("checkpointId" in record) {
    return { kind: "checkpoint", id: record.checkpointId };
  }
  if (record.kind === "annotation-removal") {
    return { kind: "removal", id: record.removalId };
  }
  return { kind: "relocation", id: record.relocationId };
}

function recordBase(
  record: RecoveryPersistenceRecordV1,
): SidecarBaseIdentityV1 | null {
  if ("base" in record) return record.base;
  if ("sidecarBase" in record) return record.sidecarBase;
  return null;
}

function recordNoteKey(record: RecoveryPersistenceRecordV1): string | null {
  if ("base" in record) return record.base.markdownPath;
  if ("noteIdentity" in record) {
    return record.noteIdentity.vaultRelativeMarkdownPath;
  }
  return null;
}

function recordSessionOrder(record: RecoveryPersistenceRecordV1): number {
  return "sessionOrder" in record ? record.sessionOrder : 0;
}

function prefixScopes(record: RecoveryPersistenceRecordV1): readonly string[] {
  if (
    !("relocationId" in record) ||
    (record.kind !== "folder-prefix" && record.kind !== "storage-root")
  ) {
    return [];
  }
  return record.kind === "storage-root"
    ? ["storage-root"]
    : [`folder:${record.priorPrefix}`, `folder:${record.replacementPrefix}`];
}

function sameStoredRecord(
  left: StoredRecoveryRecord,
  right: StoredRecoveryRecord,
): boolean {
  return (
    left.key === right.key &&
    left.activePrefixRelocation === right.activePrefixRelocation &&
    left.kind === right.kind &&
    left.noteKey === right.noteKey &&
    left.successorKey === right.successorKey &&
    left.basePath === right.basePath &&
    left.baseRevision === right.baseRevision &&
    left.baseDigest === right.baseDigest &&
    left.sessionOrder === right.sessionOrder &&
    JSON.stringify(left.noteSessionOrder) ===
      JSON.stringify(right.noteSessionOrder) &&
    JSON.stringify(left.prefixScopes) === JSON.stringify(right.prefixScopes) &&
    left.byteSize === right.byteSize &&
    left.sha256 === right.sha256 &&
    bytesEqual(left.encoded, right.encoded)
  );
}

function metadataMatchesRecord(
  stored: StoredRecoveryRecord,
  record: RecoveryPersistenceRecordV1,
): boolean {
  const base = recordBase(record);
  const noteKey = recordNoteKey(record);
  const sessionOrder = recordSessionOrder(record);
  const retained = stored.activePrefixRelocation === "retained";
  return (
    stored.key === recordKey(record) &&
    activePrefixMetadataMatches(stored, record) &&
    stored.kind === recordIdentity(record).kind &&
    stored.noteKey === noteKey &&
    stored.basePath === (base?.vaultRelativePath ?? null) &&
    stored.baseRevision === (base?.revision ?? NULL_REVISION) &&
    stored.baseDigest === (base?.rawTextSha256 ?? EMPTY_DIGEST) &&
    stored.sessionOrder === sessionOrder &&
    successorMetadataMatches(stored, noteKey, base) &&
    JSON.stringify(stored.noteSessionOrder) ===
      JSON.stringify(
        noteKey === null || sessionOrder === 0 ? null : [noteKey, sessionOrder],
      ) &&
    JSON.stringify(stored.prefixScopes) ===
      JSON.stringify(retained ? [] : prefixScopes(record))
  );
}

function successorMetadataMatches(
  stored: StoredRecoveryRecord,
  noteKey: string | null,
  base: SidecarBaseIdentityV1 | null,
): boolean {
  const expected =
    base === null || noteKey === null
      ? null
      : recoverySuccessorKey(noteKey, base);
  return stored.successorKey === expected;
}

function activePrefixMetadataMatches(
  stored: StoredRecoveryRecord,
  record: RecoveryPersistenceRecordV1,
): boolean {
  if (!isPrefixRelocation(record)) {
    return stored.activePrefixRelocation === null;
  }
  return (
    stored.activePrefixRelocation === "active" ||
    (stored.activePrefixRelocation === "retained" && record.step === "complete")
  );
}

function isPrefixRelocation(
  record: RecoveryPersistenceRecordV1,
): record is PrefixRelocationRecordV1 {
  return (
    "relocationId" in record &&
    (record.kind === "folder-prefix" || record.kind === "storage-root")
  );
}
