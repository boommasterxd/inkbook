import type { NoteSessionSnapshotV1 } from "../../application/note-session";

import type {
  ConflictStatusV1,
  DriftStatusV1,
  PersistenceStatusV1,
  RecoveryStatusV1,
  RetryStatusV1,
  StatusValidationResultV1,
} from "./models";
import {
  tryCreateConflictStatus,
  tryCreateDriftStatus,
  tryCreatePersistenceStatus,
  tryCreateRecoveryStatus,
  tryCreateRetryStatus,
} from "./validation";

export interface NoteSessionStatusProjectionV1 {
  readonly persistence: PersistenceStatusV1;
  readonly recovery: RecoveryStatusV1;
}

export interface RuntimePersistenceIssueProjectionV1 {
  readonly conflict: ConflictStatusV1;
  readonly drift: DriftStatusV1;
  readonly retry: RetryStatusV1;
}

export interface RuntimePersistenceStatusProjectionV1
  extends NoteSessionStatusProjectionV1, RuntimePersistenceIssueProjectionV1 {}

const INVALID_RESULT: StatusValidationResultV1<never> = Object.freeze({
  code: "invalid-status",
  ok: false,
});

function persistenceStatusCandidate(
  persistence: NoteSessionSnapshotV1["persistence"],
): unknown {
  switch (persistence.kind) {
    case "unannotated":
    case "first-sidecar-pending":
    case "conflict":
    case "drift":
    case "relocating":
    case "newer-version":
      return { kind: persistence.kind };
    case "clean":
      return {
        kind: persistence.kind,
        sidecarRevision: persistence.sidecarRevision,
      };
    case "dirty":
    case "saving":
      return {
        generation: persistence.generation,
        kind: persistence.kind,
      };
  }
}

export function tryProjectNoteSessionStatus(
  snapshot: NoteSessionSnapshotV1,
  recoveryAvailability: unknown,
): StatusValidationResultV1<NoteSessionStatusProjectionV1> {
  try {
    const persistence = tryCreatePersistenceStatus(
      persistenceStatusCandidate(snapshot.persistence),
    );
    if (!persistence.ok) return INVALID_RESULT;
    const recovery = tryCreateRecoveryStatus(recoveryAvailability);
    if (!recovery.ok) return INVALID_RESULT;
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        persistence: persistence.value,
        recovery: recovery.value,
      }),
    });
  } catch {
    return INVALID_RESULT;
  }
}

export function tryProjectRuntimePersistenceStatus(
  snapshot: NoteSessionSnapshotV1,
  recoveryAvailability: unknown,
  issue: unknown,
): StatusValidationResultV1<RuntimePersistenceStatusProjectionV1> {
  try {
    const base = tryProjectNoteSessionStatus(snapshot, recoveryAvailability);
    const projectedIssue = tryProjectRuntimePersistenceIssueStatus(issue);
    if (!base.ok || !projectedIssue.ok) return INVALID_RESULT;
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        ...base.value,
        ...projectedIssue.value,
      }),
    });
  } catch {
    return INVALID_RESULT;
  }
}

export function tryProjectRuntimePersistenceIssueStatus(
  issue: unknown,
): StatusValidationResultV1<RuntimePersistenceIssueProjectionV1> {
  try {
    if (issue === null || typeof issue !== "object") return INVALID_RESULT;
    const conflict = tryCreateConflictStatus(
      Reflect.get(issue, "conflict") as unknown,
    );
    const drift = tryCreateDriftStatus(Reflect.get(issue, "drift") as unknown);
    const retry = tryCreateRetryStatus(Reflect.get(issue, "retry") as unknown);
    if (!conflict.ok || !drift.ok || !retry.ok) return INVALID_RESULT;
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        conflict: conflict.value,
        drift: drift.value,
        retry: retry.value,
      }),
    });
  } catch {
    return INVALID_RESULT;
  }
}
