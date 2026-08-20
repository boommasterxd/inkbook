import type { StoredRecoveryRecord, StoredRecordKind } from "./schema";

const NULL_REVISION = -1;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const SESSION_INDEX_LENGTH = 2;
const STORED_RECORD_KEYS = [
  "activePrefixRelocation",
  "baseDigest",
  "basePath",
  "baseRevision",
  "byteSize",
  "encoded",
  "key",
  "kind",
  "noteKey",
  "noteSessionOrder",
  "prefixScopes",
  "sessionOrder",
  "sha256",
  "successorKey",
] as const;

export function parseStoredRecord(
  value: unknown,
  expectedKey?: string,
): StoredRecoveryRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<StoredRecoveryRecord>;
  if (
    !hasExactKeys(value, STORED_RECORD_KEYS) ||
    !validStoredIdentity(candidate, expectedKey) ||
    !validStoredIndices(candidate) ||
    !validStoredPayload(candidate)
  ) {
    return null;
  }
  return candidate as StoredRecoveryRecord;
}

function validStoredIdentity(
  candidate: Partial<StoredRecoveryRecord>,
  expectedKey: string | undefined,
): boolean {
  return (
    typeof candidate.key === "string" &&
    (expectedKey === undefined || candidate.key === expectedKey) &&
    isStoredKind(candidate.kind) &&
    validNullableString(candidate.noteKey)
  );
}

function validStoredIndices(candidate: Partial<StoredRecoveryRecord>): boolean {
  return (
    validNullableString(candidate.successorKey) &&
    validNullableString(candidate.basePath) &&
    validInteger(candidate.baseRevision, NULL_REVISION) &&
    typeof candidate.baseDigest === "string" &&
    validInteger(candidate.sessionOrder, 0) &&
    validSessionIndex(candidate.noteSessionOrder) &&
    validStringArray(candidate.prefixScopes) &&
    (candidate.activePrefixRelocation === null ||
      candidate.activePrefixRelocation === "active" ||
      candidate.activePrefixRelocation === "retained")
  );
}

function validStoredPayload(candidate: Partial<StoredRecoveryRecord>): boolean {
  return (
    candidate.encoded instanceof Uint8Array &&
    candidate.byteSize === candidate.encoded.byteLength &&
    typeof candidate.sha256 === "string" &&
    DIGEST_PATTERN.test(candidate.sha256)
  );
}

function isStoredKind(value: unknown): value is StoredRecordKind {
  return (
    value === "attempt" ||
    value === "checkpoint" ||
    value === "relocation" ||
    value === "removal"
  );
}

function validNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function validInteger(value: unknown, minimum: number): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
  );
}

function validSessionIndex(
  value: unknown,
): value is readonly [string, number] | null {
  return (
    value === null ||
    (Array.isArray(value) &&
      value.length === SESSION_INDEX_LENGTH &&
      typeof value[0] === "string" &&
      validInteger(value[1], 1))
  );
}

function validStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
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
