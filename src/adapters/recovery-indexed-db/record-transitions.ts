import {
  recoveryAttemptKey,
  recoveryNoteKey,
  recordsEqual,
} from "./record-codec";
import type {
  DeleteAttemptRequest,
  HostRecordedForwardProbeRecord,
  PreparedForwardProbeRecord,
  RecordDirectionRequest,
  RecordForwardRequest,
  RecoveryNoteKey,
  RecoveryProbeRecord,
} from "./types";

export interface RecordIdentifiers {
  readonly noteKey: string;
  readonly attemptKey: string;
}

export function resolvePreparedIdentifiers(
  record: PreparedForwardProbeRecord,
): RecordIdentifiers | null {
  return resolveIdentifiers(record.note, record.attemptId);
}

export function resolveDirectionIdentifiers(
  record: RecordDirectionRequest,
): RecordIdentifiers | null {
  return resolveIdentifiers(record.note, record.attemptId);
}

export function resolveRequestIdentifiers(
  request: DeleteAttemptRequest,
): RecordIdentifiers | null {
  return resolveIdentifiers(request.note, request.attemptId);
}

export function createHostRecordedRecord(
  record: RecoveryProbeRecord,
  request: RecordForwardRequest,
): HostRecordedForwardProbeRecord | null {
  if (record.sessionOrder !== request.expectedSessionOrder) {
    return null;
  }
  if (record.kind === "host-recorded-forward") {
    const candidate = { ...record, acknowledgement: request.acknowledgement };
    return recordsEqual(record, candidate) ? record : null;
  }
  return {
    ...record,
    kind: "host-recorded-forward",
    acknowledgement: request.acknowledgement,
  };
}

function resolveIdentifiers(
  note: RecoveryNoteKey,
  attemptId: string,
): RecordIdentifiers | null {
  const noteKey = recoveryNoteKey(note);
  if (noteKey === null) {
    return null;
  }
  const attemptKey = recoveryAttemptKey(noteKey, attemptId);
  return attemptKey === null ? null : { noteKey, attemptKey };
}
