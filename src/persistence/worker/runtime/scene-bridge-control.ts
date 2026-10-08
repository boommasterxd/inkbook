import type { PurposeOperationIdentity } from "../protocol";
import type {
  BridgeControl,
  BridgeBatchAcknowledgement,
  BridgeScenePaths,
  BridgeUnlockBatch,
} from "./bridge-messages";
import type { DocumentRuntimeRequest, DocumentRuntimeResult } from "./types";
import type { ScenePathReceiver } from "./scene-path-receiver";
import { cancelsSpeculativeSceneRequest } from "./request-admission";

interface ControllableRequest {
  readonly request: DocumentRuntimeRequest;
  readonly sceneReceiver: ScenePathReceiver;
  readonly abortController: AbortController;
  cancelTimeout: (() => void) | undefined;
  reject(error: Error): void;
  resolve(result: DocumentRuntimeResult): void;
}

export function cancelSpeculativeScenePreparations(
  endpoint: { postMessage(message: unknown): void },
  pending: Map<number, ControllableRequest>,
  keepNavigationReserve = false,
): void {
  for (const candidate of pending.values())
    if (
      candidate.request.type === "prepare-scene-paths" &&
      cancelsSpeculativeSceneRequest(candidate.request, keepNavigationReserve)
    )
      controlScenePreparation(endpoint, pending, candidate.request.identity);
}

export function controlScenePreparation(
  endpoint: { postMessage(message: unknown): void },
  pending: Map<number, ControllableRequest>,
  identity: PurposeOperationIdentity,
  ids?: readonly string[],
  onTransportFailure?: () => void,
): void {
  for (const [id, candidate] of pending) {
    const request = candidate.request;
    if (request.type !== "prepare-scene-paths" || !matches(request.identity, identity)) continue;
    if (ids !== undefined) {
      candidate.sceneReceiver.retarget(ids);
      continue;
    }
    pending.delete(id);
    candidate.cancelTimeout?.();
    candidate.cancelTimeout = undefined;
    candidate.abortController.abort();
    candidate.resolve({
      code: "scene-preparation-cancelled",
      identity: request.identity,
      retryable: true,
      type: "runtime-failure",
    });
  }
  try {
    endpoint.postMessage({
      action: ids === undefined ? "cancel-scene-paths" : "retarget-scene-paths",
      identity,
      ...(ids === undefined ? {} : { ids }),
      type: "inkbook-worker-control",
    } satisfies BridgeControl);
  } catch (error) {
    if (onTransportFailure === undefined) throw error;
    onTransportFailure();
  }
}

function matches(candidate: PurposeOperationIdentity, identity: PurposeOperationIdentity): boolean {
  return (
    candidate.operationId === identity.operationId &&
    candidate.sessionId === identity.sessionId &&
    candidate.workerEpoch === identity.workerEpoch &&
    candidate.purpose === identity.purpose
  );
}

export function acknowledgePathBatch(
  endpoint: { postMessage(message: unknown): void },
  message: BridgeScenePaths | BridgeUnlockBatch,
  accepted: boolean,
): void {
  endpoint.postMessage({
    accepted,
    batchIndex:
      message.type === "inkbook-worker-scene-paths" ? message.batchIndex : message.batch.batchIndex,
    requestId: message.requestId,
    type: "inkbook-worker-batch-acknowledgement",
  } satisfies BridgeBatchAcknowledgement);
}
