import type {
  ExternalChangeOutcome,
  PresentationLifecyclePort,
  RecoveryOperationIdentity,
  RecoveryResult,
  SessionOperationIdentity,
  WorkspaceSessionNotifications,
} from "./session-port";
import { isAttachedSession, transitionSession } from "./session-state";
import {
  canResolveRecovery,
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
  let outcome: ExternalChangeOutcome;
  try {
    outcome = await request.current.port.notifyExternalChange(request.operation);
  } catch {
    outcome = "reload-failed";
  }
  if (!request.isCurrent(request.operation)) return "ignored";
  if (outcome === "reloaded") {
    if (isAttachedSession(request.current.state)) request.releasePresentation();
  } else if (outcome === "conflict" || outcome === "reload-failed") {
    enterExternalChangeRecovery(request);
  }
  return outcome;
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
