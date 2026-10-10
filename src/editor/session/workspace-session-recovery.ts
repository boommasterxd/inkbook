import type {
  ExternalChangeOutcome,
  ExternalChangeResult,
  PresentationLifecyclePort,
  RecoveryOperationIdentity,
  RecoveryResult,
  SessionOperationIdentity,
  WorkspaceSessionNotifications,
} from "./session-port";
import { isAttachedSession, transitionSession } from "./session-state";
import {
  canResolveRecovery,
  cancelRecoveryOperation,
  notifyAttachedRecovery,
  notifyHeadlessRecovery,
  projectRecoveryResolution,
  type CurrentSession,
} from "./workspace-editor-coordinator-model";

interface ExternalChangeRequest {
  readonly current: CurrentSession;
  readonly isCurrent: (operation: SessionOperationIdentity) => boolean;
  readonly notifications: WorkspaceSessionNotifications;
  readonly operation: SessionOperationIdentity;
  readonly releasePresentation: () => void;
  readonly stopPresentation: () => void;
}

export async function requestExternalChange(
  request: ExternalChangeRequest,
): Promise<ExternalChangeOutcome | "ignored"> {
  if (request.current.port.notifyExternalChange === undefined) return "ignored";
  const state = request.current.state;
  cancelRecoveryOperation(request.current);
  const operation: RecoveryOperationIdentity = {
    ...request.operation,
    ...(isAttachedSession(state) ? { attachment: state.attachment } : {}),
    baseRevision: request.current.port.getSnapshot().revision,
  };
  request.current.recoveryOperation = operation;
  try {
    let outcome: ExternalChangeOutcome;
    let completed: SessionOperationIdentity = operation;
    try {
      const result = await request.current.port.notifyExternalChange(operation);
      if (typeof result === "string") outcome = result;
      else {
        if (!matchesExternalReplacement(operation, result)) return "ignored";
        completed = result;
        outcome = result.outcome;
      }
    } catch {
      outcome = "reload-failed";
    }
    if (
      request.current.recoveryOperation !== operation ||
      request.current.state !== state ||
      !request.isCurrent(completed)
    )
      return "ignored";
    if (outcome === "reloaded") {
      if (isAttachedSession(request.current.state)) request.releasePresentation();
    } else if (outcome === "conflict" || outcome === "reload-failed") {
      enterExternalChangeRecovery(request);
    }
    return outcome;
  } finally {
    if (request.current.recoveryOperation === operation)
      request.current.recoveryOperation = undefined;
  }
}

function matchesExternalReplacement(
  operation: SessionOperationIdentity,
  result: ExternalChangeResult,
): boolean {
  return (
    result.documentId === operation.documentId &&
    result.sessionId === operation.sessionId &&
    result.operationId === operation.operationId &&
    result.workspaceToken === operation.workspaceToken &&
    result.expectedSourceIdentity?.outputHash === operation.expectedSourceIdentity?.outputHash &&
    result.expectedSourceIdentity?.revision === operation.expectedSourceIdentity?.revision &&
    Number.isSafeInteger(result.workerEpoch) &&
    result.workerEpoch > operation.workerEpoch
  );
}

export function isCurrentExternalOperation(
  actual: CurrentSession | undefined,
  expected: CurrentSession,
  operation: SessionOperationIdentity,
  disposed: boolean,
  workspaceToken: number,
): boolean {
  const snapshot = expected.port.getSnapshot();
  return (
    !disposed &&
    actual === expected &&
    operation.workspaceToken === workspaceToken &&
    snapshot.documentId === operation.documentId &&
    snapshot.sessionId === operation.sessionId &&
    snapshot.workerEpoch === operation.workerEpoch
  );
}

export function releasePresentation(
  presentations: PresentationLifecyclePort,
  current: CurrentSession,
): void {
  if (isAttachedSession(current.state)) presentations.release(current.state.attachment);
}

export function stopPresentation(
  presentations: PresentationLifecyclePort,
  current: CurrentSession,
): void {
  if (!isAttachedSession(current.state)) return;
  presentations.cancelGesture(current.state.attachment);
  presentations.disableInput(current.state.attachment);
}

interface RecoveryAdoption {
  readonly action: "reload-external" | "save-local-copy";
  readonly current: CurrentSession;
  readonly isCurrent: boolean;
  readonly notifications: WorkspaceSessionNotifications;
  readonly operation: RecoveryOperationIdentity;
  readonly release: () => void;
  readonly result: RecoveryResult;
}

export function adoptRecoveryResult(request: RecoveryAdoption) {
  if (!canResolveRecovery(request.current.state, request.action) || !request.isCurrent) {
    return { confirmed: false };
  }
  request.current.recoveryOperation = undefined;
  if (request.result.status === "failed") {
    notifyHeadlessRecovery(request.current, request.notifications);
    return { confirmed: false };
  }
  request.current.state = transitionSession(
    request.current.state,
    request.action === "reload-external" ? "reload-external" : "save-local-copy-confirmed",
  );
  request.release();
  return projectRecoveryResolution(request.result);
}

function enterExternalChangeRecovery(request: ExternalChangeRequest): void {
  const phase = request.current.state.phase;
  if (phase !== "active" && phase !== "detached-saving" && phase !== "locking") return;
  if (request.current.saveOperation !== undefined) {
    request.current.port.cancelOperation(request.current.saveOperation);
    request.current.saveOperation = undefined;
  }
  if (isAttachedSession(request.current.state)) request.stopPresentation();
  request.current.state = transitionSession(request.current.state, "save-failed");
  notifyAttachedRecovery(request.current, request.notifications);
  notifyHeadlessRecovery(request.current, request.notifications);
}
