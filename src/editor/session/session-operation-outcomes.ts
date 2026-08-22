import type {
  DocumentSessionPort,
  RecoveryCompletionPort,
  RecoveryOperationIdentity,
  RecoveryResult,
  SaveResult,
  SessionOperationIdentity,
  UnlockResult,
} from "./session-port";

export function observeUnlock(
  port: DocumentSessionPort,
  operation: SessionOperationIdentity,
  adopt: (result: UnlockResult) => void,
): void {
  void port.unlock(operation).then(adopt, () => {
    adopt({ ...operation, status: "load-error" });
  });
}

export function observeSave(
  port: DocumentSessionPort,
  operation: SessionOperationIdentity,
  adopt: (result: SaveResult) => void,
): void {
  void port.lockLatest(operation).then(adopt, () => {
    adopt({
      ...operation,
      revision: port.getSnapshot().revision,
      status: "failed",
    });
  });
}

export async function requestRecovery(
  port: DocumentSessionPort,
  action: "reload-external" | "save-local-copy",
  operation: RecoveryOperationIdentity,
  completion?: RecoveryCompletionPort,
): Promise<RecoveryResult> {
  return port.resolveRecovery(action, operation, completion).catch((): RecoveryResult => ({
    ...operation,
    status: "failed",
  }));
}
