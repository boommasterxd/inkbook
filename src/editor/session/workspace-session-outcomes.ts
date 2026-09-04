import type { SaveResult, UnlockResult, WorkspaceSessionNotifications } from "./session-port";
import { transitionSession } from "./session-state";
import {
  isExactLatestConfirmation,
  notifyAttachedRecovery,
  notifyHeadlessRecovery,
  resolveActivatedRecord,
  type ActivationRecord,
  type CurrentSession,
} from "./workspace-editor-coordinator-model";

interface UnlockAdoption {
  readonly activationIsCurrent: (activation: ActivationRecord) => boolean;
  readonly current: CurrentSession;
  readonly operationIsCurrent: boolean;
  readonly result: UnlockResult;
}

export function adoptUnlockResult(request: UnlockAdoption): "done" | "release" {
  if (!request.operationIsCurrent) return "done";
  request.current.unlockOperation = undefined;
  const activation = request.current.activation;
  request.current.activation = undefined;
  if (activation === undefined || !request.activationIsCurrent(activation)) return "release";
  if (request.result.status !== "active") {
    request.current.state = transitionSession(request.current.state, "load-failed");
    activation.resolve(
      request.result.status === "source-changed"
        ? {
            actualSourceIdentity: request.result.actualSourceIdentity,
            kind: "source-changed",
            sessionId: request.result.sessionId,
            token: activation.token,
          }
        : {
            kind: "load-error",
            sessionId: request.result.sessionId,
            token: activation.token,
          },
    );
    return "done";
  }
  request.current.state = transitionSession(request.current.state, "unlock-succeeded");
  resolveActivatedRecord(activation, request.current, activation.disposition);
  return "done";
}

interface SaveAdoption {
  readonly current: CurrentSession;
  readonly notifications: WorkspaceSessionNotifications;
  readonly operationIsCurrent: boolean;
  readonly result: SaveResult;
}

export function adoptSaveResult(request: SaveAdoption): "done" | "release" | "restart" {
  if (!request.operationIsCurrent) return "done";
  request.current.saveOperation = undefined;
  if (request.result.status === "failed") {
    request.current.state = transitionSession(request.current.state, "save-failed");
    notifyAttachedRecovery(request.current, request.notifications);
    notifyHeadlessRecovery(request.current, request.notifications);
    return "done";
  }
  if (!isExactLatestConfirmation(request.current.port.getSnapshot(), request.result)) {
    return "restart";
  }
  request.current.state = transitionSession(request.current.state, "save-confirmed");
  return request.current.state.phase === "active" ? "done" : "release";
}
