import type { InkSnapshotV1 } from "../../../domain/schema/public";
import type { DocumentRuntimeResult, ModelSyncRuntimeRequest } from "../../worker/runtime/public";
import { sameOperationIdentity } from "./verification";

/** A missing or mismatched incremental baseline permits one complete Store resync. */
export async function executeAutosaveModelSynchronization(options: {
  readonly request: ModelSyncRuntimeRequest;
  readonly current: (request: ModelSyncRuntimeRequest) => boolean;
  readonly execute: (request: ModelSyncRuntimeRequest) => Promise<DocumentRuntimeResult>;
  readonly snapshot: () => InkSnapshotV1;
}): Promise<DocumentRuntimeResult> {
  const { request } = options;
  const result = await options.execute(request);
  if (!allowsFullRetry(request, result) || !options.current(request)) return result;
  const snapshot = options.snapshot();
  if (snapshot.revision !== request.modelRevision || !options.current(request)) return result;
  return options.execute({
    type: "model-sync-full",
    identity: request.identity,
    baseModelRevision: null,
    modelRevision: request.modelRevision,
    snapshot,
  });
}

function allowsFullRetry(request: ModelSyncRuntimeRequest, result: DocumentRuntimeResult): boolean {
  return (
    request.type === "model-sync-incremental" &&
    result.type === "runtime-failure" &&
    result.retryable &&
    result.code === "base-revision-mismatch" &&
    sameOperationIdentity(request.identity, result.identity)
  );
}
