import type { DocumentRuntimeRequest } from "./types";
import type { ExecutorIdentity, WorkerJobKind } from "../protocol";

export function isDocumentPrewarmRequest(request: DocumentRuntimeRequest): boolean {
  return (
    request.type === "prepare-scene-paths" &&
    request.speculative === true &&
    request.navigationReserve !== true
  );
}

export function matchesExecutorIdentity(
  identity: ExecutorIdentity,
  executor: ExecutorIdentity,
): boolean {
  return identity.sessionId === executor.sessionId && identity.workerEpoch === executor.workerEpoch;
}

export function matchesRequestExecutor(
  request: DocumentRuntimeRequest,
  executor: ExecutorIdentity,
): boolean {
  return matchesExecutorIdentity(
    request.type === "export-full" || request.type === "export-incremental"
      ? request
      : request.identity,
    executor,
  );
}

export function blocksSpeculativeWork(request: DocumentRuntimeRequest): boolean {
  return (
    request.type === "clipboard-decode" ||
    request.type === "clipboard-encode" ||
    request.type === "clipboard-plan-paste" ||
    request.type === "verify-output" ||
    request.type === "export-full" ||
    request.type === "export-incremental" ||
    ((request.type === "model-sync-full" || request.type === "model-sync-incremental") &&
      request.identity.purpose !== "background")
  );
}

export function requestJobKind(request: DocumentRuntimeRequest): WorkerJobKind {
  if (request.type === "unlock") return "unlock";
  if (
    request.type === "clipboard-decode" ||
    request.type === "clipboard-encode" ||
    request.type === "clipboard-plan-paste" ||
    request.type === "model-sync-full" ||
    request.type === "model-sync-incremental"
  )
    return "clipboard";
  if (request.type === "export-full" || request.type === "export-incremental") return "export";
  return "required";
}

export function supersedesSpeculativeSceneRequest(request: DocumentRuntimeRequest): boolean {
  return (
    isRequiredSceneRequest(request) ||
    request.type === "model-sync-full" ||
    request.type === "model-sync-incremental" ||
    request.type === "unlock"
  );
}

export function isRequiredSceneRequest(request: DocumentRuntimeRequest): boolean {
  return (
    (request.type === "prepare-scene-paths" && request.speculative !== true) ||
    ((request.type === "model-sync-full" || request.type === "model-sync-incremental") &&
      request.identity.purpose === "background")
  );
}

export function isNavigationSceneRequest(request: DocumentRuntimeRequest): boolean {
  return (
    isRequiredSceneRequest(request) ||
    (request.type === "prepare-scene-paths" && request.navigationReserve === true)
  );
}

export function cancelsSpeculativeSceneRequest(
  request: DocumentRuntimeRequest,
  keepNavigationReserve: boolean,
): boolean {
  return (
    request.type === "prepare-scene-paths" &&
    request.speculative === true &&
    !(keepNavigationReserve && request.navigationReserve === true)
  );
}
