import { ModelPointReferences } from "./model-point-references";
import type {
  DocumentRuntimeObserver,
  DocumentRuntimePort,
  DocumentRuntimeRequest,
  UnlockRuntimeBatch,
} from "./types";
import {
  decodeRuntimeRequest,
  encodeRuntimeResultChunked,
  encodeUnlockBatch,
  isDocumentRuntimeWireRequest,
} from "./wire-codec";
import type {
  BridgeBatchAcknowledgement,
  BridgeControl,
  BridgeExportAcknowledgement,
  BridgeFailure,
  BridgeRequest,
  BridgeSuccess,
  BridgeUnlockBatch,
} from "./bridge-messages";

export interface WorkerHostEndpoint {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  clearTimeout(handle: unknown): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  setTimeout(callback: () => void, milliseconds: number): unknown;
}

interface PendingAcknowledgement {
  readonly abort: () => void;
  readonly reject: (error: Error) => void;
  readonly resolve: () => void;
}

interface PendingExportAcknowledgement {
  readonly cancelTimeout: () => void;
  readonly identity: import("../protocol").ExportIdentity;
}

const EXPORT_ACKNOWLEDGEMENT_TIMEOUT_MS = 30_000;

export function attachDocumentWorkerHost(
  endpoint: WorkerHostEndpoint,
  runtime: DocumentRuntimePort,
): () => void {
  const acknowledgements = new Map<string, PendingAcknowledgement>();
  const exportAcknowledgements = new Map<number, PendingExportAcknowledgement>();
  const pointReferences = new ModelPointReferences(true);
  const listener = createHostListener(
    endpoint,
    runtime,
    acknowledgements,
    exportAcknowledgements,
    pointReferences,
  );
  endpoint.addEventListener("message", listener);
  return () => {
    endpoint.removeEventListener("message", listener);
    for (const acknowledgement of acknowledgements.values()) acknowledgement.abort();
    acknowledgements.clear();
    for (const pending of exportAcknowledgements.values()) {
      pending.cancelTimeout();
      runtime.acknowledgeExport?.(pending.identity, false);
    }
    exportAcknowledgements.clear();
    pointReferences.clear();
    runtime.terminate();
  };
}

function createHostListener(
  endpoint: WorkerHostEndpoint,
  runtime: DocumentRuntimePort,
  acknowledgements: Map<string, PendingAcknowledgement>,
  exportAcknowledgements: Map<number, PendingExportAcknowledgement>,
  pointReferences: ModelPointReferences,
): (event: MessageEvent<unknown>) => void {
  return (event) => {
    if (isBridgeControl(event.data)) {
      applyControl(runtime, event.data);
      return;
    }
    if (isBridgeBatchAcknowledgement(event.data)) {
      settleAcknowledgement(acknowledgements, event.data);
      return;
    }
    if (isBridgeExportAcknowledgement(event.data)) {
      settleExportAcknowledgement(runtime, exportAcknowledgements, event.data);
      return;
    }
    if (!isBridgeRequest(event.data)) return;
    dispatchHostedRequest(
      endpoint,
      runtime,
      acknowledgements,
      exportAcknowledgements,
      event.data,
      pointReferences,
    );
  };
}

function dispatchHostedRequest(
  endpoint: WorkerHostEndpoint,
  runtime: DocumentRuntimePort,
  acknowledgements: Map<string, PendingAcknowledgement>,
  exportAcknowledgements: Map<number, PendingExportAcknowledgement>,
  message: BridgeRequest,
  pointReferences: ModelPointReferences,
): void {
  const { requestId } = message;
  let request: DocumentRuntimeRequest;
  try {
    const wire = message.request;
    const resolvePoints =
      "baseModelRevision" in wire
        ? pointReferences.resolver(
            wire.baseModelRevision,
            "identity" in wire ? wire.identity : wire,
          )
        : undefined;
    request = decodeRuntimeRequest(wire, resolvePoints);
  } catch {
    postExecutorFailure(endpoint, requestId);
    return;
  }
  if (request.type === "unlock") pointReferences.clear();
  const observer: DocumentRuntimeObserver = {
    unlockBatch: async (batch, signal) => {
      await postUnlockBatch(endpoint, acknowledgements, requestId, batch, signal);
      pointReferences.stageUnlock(batch);
    },
  };
  void runtime.execute(request, observer).then(
    (result) => {
      pointReferences.accept(request, result);
      return postHostedResult(endpoint, runtime, exportAcknowledgements, requestId, result);
    },
    () => postExecutorFailure(endpoint, requestId),
  );
}

async function postHostedResult(
  endpoint: WorkerHostEndpoint,
  runtime: DocumentRuntimePort,
  exportAcknowledgements: Map<number, PendingExportAcknowledgement>,
  requestId: number,
  result: import("./types").DocumentRuntimeResult,
): Promise<void> {
  try {
    const controller = new AbortController();
    const admission = runtime.checkpoint?.(controller.signal);
    if (admission !== undefined) await admission;
    const encoded = await encodeRuntimeResultChunked(result, {
      checkpoint: () => runtime.checkpoint?.(controller.signal),
      signal: controller.signal,
    });
    if (result.type === "export-success") {
      const identity = {
        exportGeneration: result.exportGeneration,
        modelRevision: result.modelRevision,
        sessionId: result.sessionId,
        workerEpoch: result.workerEpoch,
      };
      const timeout = endpoint.setTimeout(() => {
        exportAcknowledgements.delete(requestId);
        runtime.acknowledgeExport?.(identity, false);
      }, EXPORT_ACKNOWLEDGEMENT_TIMEOUT_MS);
      exportAcknowledgements.set(requestId, {
        cancelTimeout: () => endpoint.clearTimeout(timeout),
        identity,
      });
    }
    endpoint.postMessage(
      { requestId, result: encoded.value, type: "inkbook-worker-result" } satisfies BridgeSuccess,
      [...encoded.transfer],
    );
  } catch {
    const pending = exportAcknowledgements.get(requestId);
    if (pending !== undefined) {
      pending.cancelTimeout();
      exportAcknowledgements.delete(requestId);
      runtime.acknowledgeExport?.(pending.identity, false);
    }
    postExecutorFailure(endpoint, requestId);
  }
}

function postExecutorFailure(endpoint: WorkerHostEndpoint, requestId: number): void {
  endpoint.postMessage({
    code: "executor-failed",
    requestId,
    type: "inkbook-worker-error",
  } satisfies BridgeFailure);
}

function postUnlockBatch(
  endpoint: WorkerHostEndpoint,
  acknowledgements: Map<string, PendingAcknowledgement>,
  requestId: number,
  batch: UnlockRuntimeBatch,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const encoded = encodeUnlockBatch(batch);
  const key = acknowledgementKey(requestId, batch.batchIndex);
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      acknowledgements.delete(key);
      signal.removeEventListener("abort", abort);
      reject(new Error("Document worker unlock batch was aborted."));
    };
    const pending = createPendingAcknowledgement(signal, abort, resolve, reject);
    acknowledgements.set(key, pending);
    signal.addEventListener("abort", abort, { once: true });
    try {
      endpoint.postMessage(
        {
          batch: encoded.value,
          requestId,
          type: "inkbook-worker-unlock-batch",
        } satisfies BridgeUnlockBatch,
        [...encoded.transfer],
      );
    } catch {
      acknowledgements.delete(key);
      pending.reject(new Error("Document worker unlock batch dispatch failed."));
    }
  });
}

function createPendingAcknowledgement(
  signal: AbortSignal,
  abort: () => void,
  resolve: () => void,
  reject: (error: Error) => void,
): PendingAcknowledgement {
  return {
    abort,
    reject: (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    },
    resolve: () => {
      signal.removeEventListener("abort", abort);
      resolve();
    },
  };
}

function applyControl(runtime: DocumentRuntimePort, control: BridgeControl): void {
  if (control.action === "cancel-scene-paths" && control.identity !== undefined)
    runtime.cancelScenePreparation?.(control.identity);
  else if (control.action === "prewarm") runtime.requestPrewarm?.();
  else if (control.action === "set-live-input")
    runtime.setLiveInputActive?.(control.active === true);
  else if (
    control.sliceMilliseconds !== undefined &&
    control.frameIntervalMilliseconds !== undefined
  ) {
    runtime.setSchedulingProfile?.(control.sliceMilliseconds, control.frameIntervalMilliseconds);
  }
}

function settleAcknowledgement(
  acknowledgements: Map<string, PendingAcknowledgement>,
  message: BridgeBatchAcknowledgement,
): void {
  const key = acknowledgementKey(message.requestId, message.batchIndex);
  const pending = acknowledgements.get(key);
  if (pending === undefined) return;
  acknowledgements.delete(key);
  if (message.accepted) pending.resolve();
  else pending.reject(new Error("Document worker unlock batch was rejected."));
}

function isBridgeRequest(value: unknown): value is BridgeRequest {
  return (
    isObject(value) &&
    value.type === "inkbook-worker-request" &&
    Number.isSafeInteger(value.requestId) &&
    isDocumentRuntimeWireRequest(value.request)
  );
}

function isBridgeControl(value: unknown): value is BridgeControl {
  return (
    isObject(value) &&
    value.type === "inkbook-worker-control" &&
    ((value.action === "cancel-scene-paths" &&
      isObject(value.identity) &&
      typeof value.identity.sessionId === "string" &&
      Number.isSafeInteger(value.identity.workerEpoch) &&
      Number.isSafeInteger(value.identity.operationId) &&
      value.identity.purpose === "background") ||
      (value.action === "prewarm" && value.active === undefined) ||
      (value.action === "set-live-input" && typeof value.active === "boolean") ||
      (value.action === "set-profile" &&
        typeof value.sliceMilliseconds === "number" &&
        Number.isFinite(value.sliceMilliseconds) &&
        value.sliceMilliseconds > 0 &&
        typeof value.frameIntervalMilliseconds === "number" &&
        Number.isFinite(value.frameIntervalMilliseconds) &&
        value.frameIntervalMilliseconds > 0))
  );
}

function isBridgeBatchAcknowledgement(value: unknown): value is BridgeBatchAcknowledgement {
  return (
    isObject(value) &&
    value.type === "inkbook-worker-batch-acknowledgement" &&
    typeof value.accepted === "boolean" &&
    Number.isSafeInteger(value.requestId) &&
    typeof value.batchIndex === "number" &&
    Number.isSafeInteger(value.batchIndex) &&
    value.batchIndex >= 0
  );
}

function isBridgeExportAcknowledgement(value: unknown): value is BridgeExportAcknowledgement {
  return (
    isObject(value) &&
    value.type === "inkbook-worker-export-acknowledgement" &&
    typeof value.accepted === "boolean" &&
    Number.isSafeInteger(value.requestId) &&
    typeof value.sessionId === "string" &&
    Number.isSafeInteger(value.workerEpoch) &&
    Number.isSafeInteger(value.exportGeneration) &&
    Number.isSafeInteger(value.modelRevision)
  );
}

function settleExportAcknowledgement(
  runtime: DocumentRuntimePort,
  pending: Map<number, PendingExportAcknowledgement>,
  message: BridgeExportAcknowledgement,
): void {
  const acknowledgement = pending.get(message.requestId);
  if (acknowledgement === undefined) return;
  const identity = acknowledgement.identity;
  if (
    identity.sessionId !== message.sessionId ||
    identity.workerEpoch !== message.workerEpoch ||
    identity.exportGeneration !== message.exportGeneration ||
    identity.modelRevision !== message.modelRevision
  ) {
    return;
  }
  acknowledgement.cancelTimeout();
  pending.delete(message.requestId);
  runtime.acknowledgeExport?.(identity, message.accepted);
}

function acknowledgementKey(requestId: number, batchIndex: number): string {
  return `${requestId}:${batchIndex}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
