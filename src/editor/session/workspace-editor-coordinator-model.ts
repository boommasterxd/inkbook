import type {
  DocumentSessionPort,
  DocumentSessionSnapshot,
  PersistedDocumentIdentity,
  RecoveryOperationIdentity,
  RecoveryResult,
  SaveResult,
  SessionFactory,
  SessionIdentity,
  SessionOperationIdentity,
  WorkspaceSessionNotifications,
} from "./session-port";
import {
  createUnlockingState,
  isAttachedSession,
  type AttachmentIdentity,
  type SessionState,
} from "./session-state";
import type {
  ActivationCancellationReason,
  ActivationOutcome,
  ActivationTarget,
  RecoveryResolution,
  WorkspaceEditorCoordinatorSnapshot,
} from "./workspace-editor-coordinator-types";

export const NOOP_NOTIFICATIONS: WorkspaceSessionNotifications = {
  attachedRecoveryRequired: () => undefined,
  headlessRecoveryRequired: () => undefined,
};

export interface ActivationRecord {
  readonly disposition: Extract<ActivationOutcome, { kind: "activated" }>["disposition"];
  readonly outcome: Promise<ActivationOutcome>;
  readonly resolve: (outcome: ActivationOutcome) => void;
  readonly target: ActivationTarget;
  readonly token: number;
}

export interface CurrentSession {
  activation: ActivationRecord | undefined;
  readonly port: DocumentSessionPort;
  recoveryOperation: RecoveryOperationIdentity | undefined;
  saveOperation: SessionOperationIdentity | undefined;
  state: SessionState;
  unlockOperation: SessionOperationIdentity | undefined;
}

export class AttachmentRegistry {
  readonly #attachments = new Map<string, ActivationTarget>();

  clear(): void {
    this.#attachments.clear();
  }

  isMounted(target: ActivationTarget): boolean {
    const mounted = this.#attachments.get(target.attachmentId);
    return mounted !== undefined && sameTarget(mounted, target);
  }

  mount(target: ActivationTarget): boolean {
    if (!isValidTarget(target)) {
      return false;
    }
    const mounted = this.#attachments.get(target.attachmentId);
    if (mounted !== undefined && mounted.attachmentGeneration >= target.attachmentGeneration) {
      return sameTarget(mounted, target);
    }
    this.#attachments.set(target.attachmentId, target);
    return true;
  }

  unmount(target: ActivationTarget): boolean {
    if (!this.isMounted(target)) {
      return false;
    }
    return this.#attachments.delete(target.attachmentId);
  }
}

export class SessionOperationTracker {
  #operationId = 0;

  create(
    current: CurrentSession,
    workspaceToken: number,
    expectedSourceIdentity?: PersistedDocumentIdentity,
  ): SessionOperationIdentity {
    const snapshot = current.port.getSnapshot();
    return {
      documentId: snapshot.documentId,
      ...(expectedSourceIdentity === undefined ? {} : { expectedSourceIdentity }),
      operationId: ++this.#operationId,
      sessionId: snapshot.sessionId,
      workerEpoch: snapshot.workerEpoch,
      workspaceToken,
    };
  }

  createRecovery(current: CurrentSession, workspaceToken: number): RecoveryOperationIdentity {
    const operation = this.create(current, workspaceToken);
    return {
      ...operation,
      ...(isAttachedSession(current.state) ? { attachment: current.state.attachment } : {}),
      baseRevision: current.port.getSnapshot().revision,
    };
  }

  matches(
    coordinatorCurrent: CurrentSession | undefined,
    current: CurrentSession,
    expected: SessionOperationIdentity | undefined,
    operation: SessionOperationIdentity,
    result: SessionOperationIdentity,
    disposed: boolean,
  ): boolean {
    if (
      disposed ||
      coordinatorCurrent !== current ||
      expected !== operation ||
      !sameOperationLineage(operation, result)
    ) {
      return false;
    }
    const snapshot = current.port.getSnapshot();
    return (
      snapshot.documentId === result.documentId &&
      snapshot.sessionId === result.sessionId &&
      snapshot.workerEpoch === result.workerEpoch
    );
  }

  matchesRecovery(
    coordinatorCurrent: CurrentSession | undefined,
    current: CurrentSession,
    expected: RecoveryOperationIdentity | undefined,
    operation: RecoveryOperationIdentity,
    result: RecoveryResult,
    lifecycle: { readonly disposed: boolean; readonly workspaceToken: number },
  ): boolean {
    if (
      operation.workspaceToken !== lifecycle.workspaceToken ||
      current.port.getSnapshot().revision !== operation.baseRevision ||
      !this.matches(coordinatorCurrent, current, expected, operation, result, lifecycle.disposed)
    ) {
      return false;
    }
    return operation.attachment === undefined
      ? !isAttachedSession(current.state)
      : isAttachedSession(current.state) &&
          sameAttachment(current.state.attachment, operation.attachment);
  }
}

export function cancelRecoveryOperation(current: CurrentSession): void {
  if (current.recoveryOperation === undefined) return;
  current.port.cancelOperation(current.recoveryOperation);
  current.recoveryOperation = undefined;
}

export function withDisposition(
  record: ActivationRecord,
  disposition: ActivationRecord["disposition"],
): ActivationRecord {
  return { ...record, disposition };
}

export function createActivationRecord(target: ActivationTarget, token: number): ActivationRecord {
  let resolve!: (outcome: ActivationOutcome) => void;
  const outcome = new Promise<ActivationOutcome>((complete) => {
    resolve = complete;
  });
  return {
    disposition: "new-session",
    outcome,
    resolve,
    target: { ...target },
    token,
  };
}

export function createCurrentSession(
  record: ActivationRecord,
  sessionId: string,
  sessions: SessionFactory,
): CurrentSession {
  const identity: SessionIdentity = { documentId: record.target.documentId, sessionId };
  const port = sessions.create(identity);
  assertPortIdentity(port.getSnapshot(), identity);
  return {
    activation: record,
    port,
    recoveryOperation: undefined,
    saveOperation: undefined,
    state: createUnlockingState(toAttachment(record.target)),
    unlockOperation: undefined,
  };
}

export function resolveActivatedRecord(
  record: ActivationRecord,
  current: CurrentSession,
  disposition: Extract<ActivationOutcome, { kind: "activated" }>["disposition"],
): void {
  const phase = current.state.phase;
  if (phase === "load-error") {
    record.resolve({
      kind: "load-error",
      sessionId: current.port.getSnapshot().sessionId,
      token: record.token,
    });
    return;
  }
  if (phase !== "active" && phase !== "locking" && phase !== "save-error") {
    cancelActivationRecord(record, "superseded");
    return;
  }
  record.resolve({
    disposition,
    kind: "activated",
    phase,
    sessionId: current.port.getSnapshot().sessionId,
    token: record.token,
  });
}

export function cancelActivationRecord(
  record: ActivationRecord,
  reason: ActivationCancellationReason,
): void {
  record.resolve({ kind: "cancelled", reason, token: record.token });
}

export function notifyHeadlessRecovery(
  current: CurrentSession,
  notifications: WorkspaceSessionNotifications,
): void {
  if (current.state.phase !== "headless-recovery") {
    return;
  }
  const snapshot = current.port.getSnapshot();
  notifications.headlessRecoveryRequired({
    documentId: snapshot.documentId,
    phase: "headless-recovery",
    sessionId: snapshot.sessionId,
  });
}

export function notifyAttachedRecovery(
  current: CurrentSession,
  notifications: WorkspaceSessionNotifications,
): void {
  if (current.state.phase !== "save-error") {
    return;
  }
  const snapshot = current.port.getSnapshot();
  notifications.attachedRecoveryRequired({
    ...current.state.attachment,
    documentId: snapshot.documentId,
    phase: "save-error",
    sessionId: snapshot.sessionId,
  });
}

export function projectCurrent(
  current: CurrentSession,
): NonNullable<WorkspaceEditorCoordinatorSnapshot["current"]> {
  const snapshot = current.port.getSnapshot();
  return {
    ...(isAttachedSession(current.state) ? { attachment: current.state.attachment } : {}),
    dirty: snapshot.dirty,
    documentId: snapshot.documentId,
    persistencePending: snapshot.persistencePending,
    phase: current.state.phase,
    revision: snapshot.revision,
    sessionId: snapshot.sessionId,
  };
}

export function hasAttachment(
  current: CurrentSession,
  target: ActivationTarget,
): current is CurrentSession & {
  state: Extract<SessionState, { attachment: AttachmentIdentity }>;
} {
  return isAttachedSession(current.state) && sameAttachment(current.state.attachment, target);
}

export function isCurrentActivation(
  attachments: AttachmentRegistry,
  coordinatorCurrent: CurrentSession | undefined,
  current: CurrentSession,
  record: ActivationRecord,
  workspaceToken: number,
): boolean {
  return (
    attachments.isMounted(record.target) &&
    coordinatorCurrent === current &&
    isAttachedSession(current.state) &&
    sameAttachment(current.state.attachment, record.target) &&
    record.token === workspaceToken
  );
}

export function canResolveRecovery(
  state: SessionState | undefined,
  action: "reload-external" | "save-local-copy",
): state is SessionState {
  if (state?.phase === "headless-recovery") {
    return true;
  }
  return state?.phase === "save-error" && action === "save-local-copy";
}

export function isExactLatestConfirmation(
  snapshot: DocumentSessionSnapshot,
  result: SaveResult,
): boolean {
  return (
    !snapshot.dirty &&
    !snapshot.persistencePending &&
    snapshot.confirmedRevision === result.revision &&
    snapshot.revision === result.revision
  );
}

export function projectRecoveryResolution(result: RecoveryResult): RecoveryResolution {
  return {
    confirmed: true,
    ...(result.savedPath === undefined ? {} : { savedPath: result.savedPath }),
  };
}

function assertPortIdentity(snapshot: DocumentSessionSnapshot, identity: SessionIdentity): void {
  if (snapshot.documentId !== identity.documentId || snapshot.sessionId !== identity.sessionId) {
    throw new Error("Session factory returned a port with a mismatched identity");
  }
}

export function sameAttachment(left: AttachmentIdentity, right: AttachmentIdentity): boolean {
  return (
    left.attachmentId === right.attachmentId &&
    left.attachmentGeneration === right.attachmentGeneration
  );
}

export function sameTarget(left: ActivationTarget, right: ActivationTarget): boolean {
  return left.documentId === right.documentId && sameAttachment(left, right);
}

function sameOperationLineage(
  left: SessionOperationIdentity,
  right: SessionOperationIdentity,
): boolean {
  return (
    left.documentId === right.documentId &&
    sameOptionalSourceIdentity(left.expectedSourceIdentity, right.expectedSourceIdentity) &&
    left.operationId === right.operationId &&
    left.sessionId === right.sessionId &&
    right.workerEpoch >= left.workerEpoch &&
    left.workspaceToken === right.workspaceToken
  );
}

function sameOptionalSourceIdentity(
  left: PersistedDocumentIdentity | undefined,
  right: PersistedDocumentIdentity | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.revision === right.revision &&
      left.outputHash === right.outputHash)
  );
}

function isValidTarget(target: ActivationTarget): boolean {
  return (
    target.attachmentId.length > 0 &&
    target.documentId.length > 0 &&
    Number.isSafeInteger(target.attachmentGeneration) &&
    target.attachmentGeneration >= 0
  );
}

export function toAttachment(target: ActivationTarget): AttachmentIdentity {
  return {
    attachmentGeneration: target.attachmentGeneration,
    attachmentId: target.attachmentId,
  };
}
