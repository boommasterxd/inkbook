import type { DocumentModelRuntime } from "./document-model";
import type {
  DocumentRuntimeObserver,
  DocumentRuntimeRequest,
  DocumentRuntimeResult,
  RuntimeSliceContext,
} from "../types";
import { emitUnlockBatches } from "./unlock-batches";

export async function runVerifyOutputRequest(
  model: DocumentModelRuntime,
  request: Extract<DocumentRuntimeRequest, { type: "verify-output" }>,
  context: RuntimeSliceContext | undefined,
): Promise<DocumentRuntimeResult> {
  const parsed = await model.verifyOutput(request.input, context, {
    ...(request.expectedBytes === undefined ? {} : { expectedBytes: request.expectedBytes }),
    versionPolicy:
      request.versionPolicy ?? (request.identity.purpose === "read-back" ? "current" : "editable"),
    ...(request.identity.purpose === "preflight" && request.confirmedBase !== undefined
      ? { confirmedBase: request.confirmedBase }
      : {}),
  });
  return {
    identity: request.identity,
    persisted: parsed === null ? { type: "unreadable" } : { ...parsed, type: "confirmed" },
    type: "verify-output-success",
  };
}

export async function runUnlockRequest(
  model: DocumentModelRuntime,
  request: Extract<DocumentRuntimeRequest, { type: "unlock" }>,
  context: RuntimeSliceContext | undefined,
  observer: DocumentRuntimeObserver | undefined,
): Promise<DocumentRuntimeResult> {
  let batchCount = 0;
  const unlocked = await model.unlock(
    request.input,
    context,
    async (snapshot, derivations, adoptionSignal) => {
      batchCount = await emitUnlockBatches(
        request.identity,
        snapshot.elements,
        derivations,
        observer,
        adoptionSignal,
      );
    },
    request.safeStaticProof,
  );
  const { snapshot } = unlocked;
  return {
    identity: request.identity,
    lockedHeight: unlocked.lockedHeight,
    outputHash: unlocked.outputHash,
    requiresCanonicalRewrite: unlocked.requiresCanonicalRewrite,
    sourceVersion: unlocked.sourceVersion,
    snapshot: {
      batchCount,
      elementCount: snapshot.elements.length,
      format: snapshot.format,
      page: snapshot.page,
      revision: snapshot.revision,
      version: snapshot.version,
    },
    type: "unlock-success",
  };
}
