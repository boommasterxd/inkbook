import {
  DEFAULT_NOTE_BYTE_LIMIT,
  type DeleteAttemptRequest,
  type PreparedForwardProbeRecord,
  type RecordDirectionRequest,
  type RecordForwardRequest,
  type RecoveryNoteKey,
} from "./types";

const KIB = 1_024;
// eslint-disable-next-line @typescript-eslint/no-magic-numbers
const REQUEST_BASE_BYTES = 4 * KIB;
const JSON_AND_CLONE_BYTES_PER_CODE_UNIT = 14;
const MUTATION_COMPLETION_BYTES = KIB;
// Load decoding conservatively covers stored, parsed, sorted, and owned output.
const LOAD_DECODE_MULTIPLIER = 4;
// Queue retention and persistence cloning are charged independently.
const QUEUED_AND_PERSISTENCE_COPIES = 2;
export const LOAD_COMPLETION_BYTES =
  DEFAULT_NOTE_BYTE_LIMIT * LOAD_DECODE_MULTIPLIER;

export interface MeasuredRecoveryCharge {
  readonly completionBytes: number;
  readonly persistenceBytes: number;
  readonly queuedBytes: number;
}

export function measureRecordCharge(
  record: PreparedForwardProbeRecord | RecordDirectionRequest,
): MeasuredRecoveryCharge | null {
  const acknowledgement =
    "acknowledgement" in record ? record.acknowledgement : undefined;
  const characters = sumLengths([
    record.note.vaultIdentityHint,
    record.note.markdownPath,
    record.attemptId,
    record.forwardPatch,
    record.inversePatch,
    record.kind,
    acknowledgement?.editorViewId,
    acknowledgement?.effectId,
  ]);
  return measuredCharge(characters, MUTATION_COMPLETION_BYTES);
}

export function measureForwardRequestCharge(
  request: RecordForwardRequest,
): MeasuredRecoveryCharge | null {
  const characters = sumLengths([
    request.note.vaultIdentityHint,
    request.note.markdownPath,
    request.attemptId,
    request.acknowledgement.editorViewId,
    request.acknowledgement.effectId,
  ]);
  return measuredCharge(characters, MUTATION_COMPLETION_BYTES);
}

export function measureNoteRequestCharge(
  request: RecoveryNoteKey | DeleteAttemptRequest,
  completionBytes = MUTATION_COMPLETION_BYTES,
): MeasuredRecoveryCharge | null {
  const note = "note" in request ? request.note : request;
  const attemptId = "attemptId" in request ? request.attemptId : undefined;
  const characters = sumLengths([
    note.vaultIdentityHint,
    note.markdownPath,
    attemptId,
  ]);
  return measuredCharge(characters, completionBytes);
}

function measuredCharge(
  characters: number | null,
  completionBytes: number,
): MeasuredRecoveryCharge | null {
  if (characters === null) return null;
  const queuedBytes =
    REQUEST_BASE_BYTES + characters * JSON_AND_CLONE_BYTES_PER_CODE_UNIT;
  const persistenceBytes = queuedBytes * QUEUED_AND_PERSISTENCE_COPIES;
  if (
    !Number.isSafeInteger(queuedBytes) ||
    !Number.isSafeInteger(persistenceBytes)
  ) {
    return null;
  }
  return { completionBytes, persistenceBytes, queuedBytes };
}

function sumLengths(values: readonly unknown[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === undefined) continue;
    if (typeof value !== "string") return null;
    total += value.length;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}
