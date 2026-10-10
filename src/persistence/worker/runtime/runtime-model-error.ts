import type { DocumentRuntimeRequest, DocumentRuntimeResult } from "./types";

export class RuntimeModelError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(code);
    this.name = "RuntimeModelError";
  }
}

export function runtimeFailure(
  request: DocumentRuntimeRequest,
  error: unknown,
): DocumentRuntimeResult {
  if (request.type === "export-full" || request.type === "export-incremental") {
    return {
      error: {
        code: error instanceof RuntimeModelError ? error.code : "runtime-failure",
        retryable: error instanceof RuntimeModelError && error.retryable,
      },
      exportGeneration: request.exportGeneration,
      modelRevision: request.modelRevision,
      sessionId: request.sessionId,
      type: "export-failure",
      workerEpoch: request.workerEpoch,
    };
  }
  return {
    code: error instanceof RuntimeModelError ? error.code : "runtime-failure",
    identity: request.identity,
    retryable: error instanceof RuntimeModelError && error.retryable,
    type: "runtime-failure",
  };
}
