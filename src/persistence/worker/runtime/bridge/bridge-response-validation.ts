import type { BridgeResponse } from "./bridge-messages";
import type { WorkerRuntimeFailure } from "./worker-bridge-contracts";
import { isDocumentRuntimeWireResult, isDocumentRuntimeWireUnlockBatch } from "../wire/wire-codec";

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
      (value.type === "inkbook-worker-error" &&
        value.code === "executor-failed" &&
        (value.phase === undefined ||
          value.phase === "host-decoding" ||
          value.phase === "host-execution" ||
          value.phase === "host-encoding")) ||
      (value.type === "inkbook-worker-result" && isDocumentRuntimeWireResult(value.result)) ||
      (value.type === "inkbook-worker-unlock-batch" &&
        isDocumentRuntimeWireUnlockBatch(value.batch)))
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Only standard exception names are diagnostic; messages may contain document content. */
export function workerEventErrorName(event: unknown): WorkerRuntimeFailure["errorName"] {
  if (!isObject(event) || !isObject(event.error) || typeof event.error.name !== "string")
    return undefined;
  const names = [
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "DataCloneError",
    "SecurityError",
    "AbortError",
    "NotSupportedError",
  ];
  return names.includes(event.error.name)
    ? (event.error.name as WorkerRuntimeFailure["errorName"])
    : undefined;
}
