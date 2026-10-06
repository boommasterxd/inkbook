import type { DocumentRuntimeRequest } from "./types";

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
