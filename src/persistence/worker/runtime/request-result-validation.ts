import { parseSafeSvgRoot } from "../../documents/svg-envelope-root";
import { parseOpeningTag } from "../../documents/svg-tag";
import { hashRuntimeInput } from "./runtime-input-hash";

import type { RuntimeWireSliceOptions } from "./element-wire-codec";
import type { DocumentRuntimeRequest, DocumentRuntimeResult, UnlockRuntimeBatch } from "./types";

export function matchesUnlockBatchIdentity(
  batch: Pick<UnlockRuntimeBatch, "identity">,
  request: DocumentRuntimeRequest,
): boolean {
  if (request.type !== "unlock") return false;
  return (
    batch.identity.sessionId === request.identity.sessionId &&
    batch.identity.workerEpoch === request.identity.workerEpoch &&
    batch.identity.operationId === request.identity.operationId &&
    batch.identity.purpose === request.identity.purpose
  );
}

export async function assertResultMatchesRequest(
  request: DocumentRuntimeRequest,
  result: DocumentRuntimeResult,
  options: RuntimeWireSliceOptions,
): Promise<void> {
  if (!matchesRequestIdentity(request, result)) {
    throw new TypeError("Worker result does not match its exact request identity and purpose.");
  }
  if (
    request.type !== "verify-output" ||
    result.type !== "verify-output-success" ||
    result.persisted.type !== "confirmed"
  ) {
    return;
  }
  // The bundled worker already validated the markup. Bind its answer to these exact
  // request bytes, rather than parsing every path again on the receiving thread.
  const outputHash = await hashRuntimeInput(request.input, options);
  const prefix =
    typeof request.input === "string"
      ? request.input.slice(0, 4096)
      : new TextDecoder().decode(request.input.subarray(0, 4096));
  const tag = parseOpeningTag(prefix, 0);
  const root =
    tag === null
      ? null
      : parseSafeSvgRoot(tag, request.identity.purpose === "read-back" ? "current" : "editable");
  if (root?.revision !== result.persisted.revision || outputHash !== result.persisted.outputHash) {
    throw new TypeError("Worker verification result does not describe the exact request content.");
  }
}

function matchesRequestIdentity(
  request: DocumentRuntimeRequest,
  result: DocumentRuntimeResult,
): boolean {
  if (request.type === "export-full" || request.type === "export-incremental") {
    return (
      (result.type === "export-success" || result.type === "export-failure") &&
      result.sessionId === request.sessionId &&
      result.workerEpoch === request.workerEpoch &&
      result.exportGeneration === request.exportGeneration &&
      result.modelRevision === request.modelRevision
    );
  }
  if (request.type === "model-sync-full" || request.type === "model-sync-incremental") {
    return (
      result.type === "model-sync-success" &&
      result.modelRevision === request.modelRevision &&
      sameIdentity(request.identity, result.identity)
    );
  }
  if (result.type === "runtime-failure") return sameIdentity(request.identity, result.identity);
  const expectedType = SUCCESS_TYPE_BY_REQUEST[request.type];
  return result.type === expectedType && sameIdentity(request.identity, result.identity);
}

const SUCCESS_TYPE_BY_REQUEST = {
  "clipboard-decode": "clipboard-decode-success",
  "clipboard-encode": "clipboard-encode-success",
  "clipboard-plan-paste": "clipboard-plan-paste-success",
  "model-sync-full": "model-sync-success",
  "model-sync-incremental": "model-sync-success",
  unlock: "unlock-success",
  "verify-output": "verify-output-success",
} as const;

function sameIdentity(
  expected: Exclude<
    DocumentRuntimeRequest,
    { type: "export-full" | "export-incremental" }
  >["identity"],
  actual: Exclude<DocumentRuntimeResult, { type: "export-failure" | "export-success" }>["identity"],
): boolean {
  return (
    expected.sessionId === actual.sessionId &&
    expected.workerEpoch === actual.workerEpoch &&
    expected.operationId === actual.operationId &&
    expected.purpose === actual.purpose
  );
}
