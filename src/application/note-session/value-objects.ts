import type {
  HostTransactionSequence,
  LayoutRevision,
  NoteIdentityV1,
  RecoveryAttemptId,
  RelocationId,
  RemovalId,
  SaveGeneration,
  SessionOrder,
  SettingsRevision,
  Sha256Digest,
  SidecarRevision,
  SourceCheckpointId,
  SourceGeneration,
  ViewId,
  HostEffectId,
} from "./types";

const ID_PAYLOAD_PATTERN = "[0-7][0-9a-hjkmnp-tv-z]{25}";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const VIEW_ID_MAX_LENGTH = 512;

function parsePrefixedId<T extends string>(value: string, prefix: string): T {
  const pattern = new RegExp(`^${prefix}_${ID_PAYLOAD_PATTERN}$`, "u");
  if (!pattern.test(value)) throw new TypeError(`Invalid ${prefix} ID syntax.`);
  return value as T;
}

function createPositiveCounter<T extends number>(value: number): T {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("A counter must be a positive safe integer.");
  }
  return value as T;
}

export function parseHostEffectId(value: string): HostEffectId {
  return parsePrefixedId<HostEffectId>(value, "eff");
}

export function parseRecoveryAttemptId(value: string): RecoveryAttemptId {
  return parsePrefixedId<RecoveryAttemptId>(value, "ra");
}

export function parseSourceCheckpointId(value: string): SourceCheckpointId {
  return parsePrefixedId<SourceCheckpointId>(value, "scp");
}

export function parseRelocationId(value: string): RelocationId {
  return parsePrefixedId<RelocationId>(value, "rel");
}

export function parseRemovalId(value: string): RemovalId {
  return parsePrefixedId<RemovalId>(value, "rm");
}

export function parseViewId(value: string): ViewId {
  if (
    value.length === 0 ||
    value.length > VIEW_ID_MAX_LENGTH ||
    value.includes("\0")
  ) {
    throw new TypeError("Invalid view ID syntax.");
  }
  return value as ViewId;
}

export function parseSha256Digest(value: string): Sha256Digest {
  if (!SHA256_PATTERN.test(value)) {
    throw new TypeError("Invalid SHA-256 digest syntax.");
  }
  return value as Sha256Digest;
}

export function createHostTransactionSequence(
  value: number,
): HostTransactionSequence {
  return createPositiveCounter<HostTransactionSequence>(value);
}

export function createSessionOrder(value: number): SessionOrder {
  return createPositiveCounter<SessionOrder>(value);
}

export function createSidecarRevision(value: number): SidecarRevision {
  return createPositiveCounter<SidecarRevision>(value);
}

export function createSaveGeneration(value: number): SaveGeneration {
  return createPositiveCounter<SaveGeneration>(value);
}

export function createSourceGeneration(value: number): SourceGeneration {
  return createPositiveCounter<SourceGeneration>(value);
}

export function createSettingsRevision(value: number): SettingsRevision {
  return createPositiveCounter<SettingsRevision>(value);
}

export function createLayoutRevision(value: number): LayoutRevision {
  return createPositiveCounter<LayoutRevision>(value);
}

export function freezeNoteIdentity(value: NoteIdentityV1): NoteIdentityV1 {
  if (
    value.vaultIdHint.length === 0 ||
    value.vaultRelativeMarkdownPath.length === 0 ||
    value.vaultIdHint.includes("\0") ||
    value.vaultRelativeMarkdownPath.includes("\0")
  ) {
    throw new TypeError("Invalid note identity.");
  }
  return Object.freeze({ ...value });
}
