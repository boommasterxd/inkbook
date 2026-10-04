import type { BridgeResponse } from "./bridge-messages";
import { isDocumentRuntimeWireResult, isDocumentRuntimeWireUnlockBatch } from "./wire-codec";

export function isBridgeResponse(value: unknown): value is BridgeResponse {
  return (
    isObject(value) &&
    (value.type === "inkbook-worker-result" ||
      value.type === "inkbook-worker-error" ||
      value.type === "inkbook-worker-scene-paths" ||
      value.type === "inkbook-worker-unlock-batch") &&
    Number.isSafeInteger(value.requestId) &&
    ((value.type === "inkbook-worker-scene-paths" &&
      Number.isSafeInteger(value.batchIndex) &&
      isObject(value.batch) &&
      value.batch.type === "prepare-scene-paths-success") ||
      (value.type === "inkbook-worker-error" && value.code === "executor-failed") ||
      (value.type === "inkbook-worker-result" && isDocumentRuntimeWireResult(value.result)) ||
      (value.type === "inkbook-worker-unlock-batch" &&
        isDocumentRuntimeWireUnlockBatch(value.batch)))
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
