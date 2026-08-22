import type {
  PresentationLifecyclePort,
  SessionOperationIdentity,
  UnlockResult,
  WorkspaceSessionNotifications,
} from "./session-port";
import { observeUnlock } from "./session-operation-outcomes";
import {
  isAttachedSession,
  reattachSession,
  replaceSessionAttachment,
  transitionSession,
} from "./session-state";
import {
  cancelActivationRecord,
  cancelRecoveryOperation,
  notifyAttachedRecovery,
  resolveActivatedRecord,
  sameAttachment,
  toAttachment,
  withDisposition,
  type ActivationRecord,
  type CurrentSession,
} from "./workspace-editor-coordinator-model";

interface SameAttachmentActivation {
  readonly adoptUnlock: (operation: SessionOperationIdentity, result: UnlockResult) => void;
  readonly createOperation: () => SessionOperationIdentity;
  readonly current: CurrentSession;
  readonly record: ActivationRecord;
}

export function tryActivateSameAttachment(request: SameAttachmentActivation): boolean {
  const { current, record } = request;
  if (
    !isAttachedSession(current.state) ||
    !sameAttachment(current.state.attachment, record.target)
  ) {
    return false;
  }
  cancelRecoveryOperation(current);
  if (current.state.phase === "unlocking") {
    if (current.activation !== undefined) cancelActivationRecord(current.activation, "superseded");
    current.activation = withDisposition(record, "already-current");
  } else if (current.state.phase === "load-error") {
    current.state = transitionSession(current.state, "retry-load");
    current.activation = withDisposition(record, "already-current");
    const operation = request.createOperation();
    current.unlockOperation = operation;
    observeUnlock(current.port, operation, (result) => request.adoptUnlock(operation, result));
  } else {
    resolveActivatedRecord(record, current, "already-current");
  }
  return true;
}

interface SessionHandoff {
  readonly current: CurrentSession;
  readonly notifications: WorkspaceSessionNotifications;
  readonly presentations: PresentationLifecyclePort;
  readonly record: ActivationRecord;
}

export function handoffSession(request: SessionHandoff): void {
  const { current, record } = request;
  cancelRecoveryOperation(current);
  const wasDetached = !isAttachedSession(current.state);
  if (isAttachedSession(current.state)) {
    request.presentations.cancelGesture(current.state.attachment);
    request.presentations.release(current.state.attachment);
    current.state = replaceSessionAttachment(current.state, toAttachment(record.target));
  } else {
    current.state = reattachSession(current.state, toAttachment(record.target));
  }
  if (current.state.phase === "unlocking") {
    if (current.activation !== undefined) cancelActivationRecord(current.activation, "superseded");
    current.activation = withDisposition(record, "same-document-handoff");
    return;
  }
  notifyAttachedRecovery(current, request.notifications);
  resolveActivatedRecord(record, current, wasDetached ? "reattached" : "same-document-handoff");
}
