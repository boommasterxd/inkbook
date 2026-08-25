import type {
  DocumentRuntimeObserver,
  DocumentRuntimePort,
  DocumentRuntimeRequest,
  DocumentRuntimeResult,
  UnlockRuntimeBatch,
} from "./types";
import type { ExportIdentity } from "../protocol";
import { yieldToMainThread } from "../../scheduling/main-thread-yield";
import {
  decodeUnlockBatch,
  decodeRuntimeResultChunked,
  encodeRuntimeRequestChunked,
  isDocumentRuntimeWireResult,
  isDocumentRuntimeWireUnlockBatch,
} from "./wire-codec";
import { assertResultMatchesRequest } from "./request-result-validation";
import type {
  BridgeBatchAcknowledgement,
  BridgeControl,
  BridgeExportAcknowledgement,
  BridgeRequest,
  BridgeResponse,
  BridgeSuccess,
  BridgeUnlockBatch,
} from "./bridge-messages";

const DESKTOP_MAIN_THREAD_SLICE_MS = 8;
const MOBILE_MAIN_THREAD_SLICE_MS = 12;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface WorkerBridgeEndpoint {
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  removeEventListener(type: "error", listener: () => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  terminate(): void;
}

interface PendingBridgeRequest {
  readonly acceptsUnlockBatches: boolean;
  adoptedElementCount: number;
  readonly abortController: AbortController;
  batchAdoptionPending: boolean;
  nextUnlockBatchIndex: number;
  readonly observer: DocumentRuntimeObserver | undefined;
  readonly reject: (error: Error) => void;
  readonly request: DocumentRuntimeRequest;
  resultAdoptionPending: boolean;
  readonly resolve: (result: DocumentRuntimeResult) => void;
  cancelTimeout: (() => void) | undefined;
}

export interface WorkerRuntimeFailure {
  readonly kind: "error" | "protocol" | "timeout";
  readonly request?: DocumentRuntimeRequest;
}

export interface WorkerDocumentRuntimePortOptions {
  readonly onExecutorFailure?: (failure: WorkerRuntimeFailure) => void;
  readonly profile?: "desktop" | "mobile";
  readonly requestTimeoutMilliseconds?: number;
  readonly sliceMilliseconds?: number | (() => number);
}

export class WorkerDocumentRuntimePort implements DocumentRuntimePort {
  readonly #endpoint: WorkerBridgeEndpoint;
  readonly #onExecutorFailure: ((failure: WorkerRuntimeFailure) => void) | undefined;
  readonly #pending = new Map<number, PendingBridgeRequest>();
  readonly #exportReceipts = new Map<string, BridgeSuccess>();
  readonly #requestTimeoutMilliseconds: number;
  readonly #sliceMilliseconds: () => number;
  readonly #inputWaiters = new Set<() => void>();
  #failureReported = false;
  #liveInputActive = false;
  #nextRequestId = 0;
  #terminated = false;

  public constructor(
    createWorker: () => WorkerBridgeEndpoint,
    options: WorkerDocumentRuntimePortOptions = {},
  ) {
    const timeout = options.requestTimeoutMilliseconds ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!(timeout > 0) || !Number.isFinite(timeout)) {
      throw new RangeError("requestTimeoutMilliseconds must be a positive finite number.");
    }
    this.#requestTimeoutMilliseconds = timeout;
    const configuredSlice =
      options.sliceMilliseconds ??
      (options.profile === "mobile" ? MOBILE_MAIN_THREAD_SLICE_MS : DESKTOP_MAIN_THREAD_SLICE_MS);
    this.#sliceMilliseconds =
      typeof configuredSlice === "function" ? configuredSlice : () => configuredSlice;
    this.#onExecutorFailure = options.onExecutorFailure;
    this.#endpoint = createWorker();
    this.#endpoint.addEventListener("message", this.#onMessage);
    this.#endpoint.addEventListener("error", this.#onError);
  }

  public execute(
    request: DocumentRuntimeRequest,
    observer?: DocumentRuntimeObserver,
  ): Promise<DocumentRuntimeResult> {
    if (this.#terminated) return Promise.reject(new Error("Document worker port is terminated."));
    const requestId = ++this.#nextRequestId;
    return new Promise((resolve, reject) => {
      const pending: PendingBridgeRequest = {
        acceptsUnlockBatches: request.type === "unlock",
        adoptedElementCount: 0,
        abortController: new AbortController(),
        batchAdoptionPending: false,
        nextUnlockBatchIndex: 0,
        observer,
        reject,
        request,
        resultAdoptionPending: false,
        resolve,
        cancelTimeout: undefined,
      };
      pending.cancelTimeout = scheduleTimeout(
        () => this.#timeoutRequest(requestId, pending),
        this.#requestTimeoutMilliseconds,
      );
      this.#pending.set(requestId, pending);
      void this.#dispatch(requestId, request, pending);
    });
  }

  public requestPrewarm(): void {
    if (this.#terminated) return;
    try {
      this.#endpoint.postMessage({
        action: "prewarm",
        type: "inkbook-worker-control",
      } satisfies BridgeControl);
    } catch {
      this.#failExecutor("error");
    }
  }

  public acknowledgeExport(identity: ExportIdentity, accepted: boolean): void {
    const key = exportIdentityKey(identity);
    const message = this.#exportReceipts.get(key);
    if (message === undefined) return;
    this.#exportReceipts.delete(key);
    this.#acknowledgeExport(message, accepted);
  }

  public setLiveInputActive(active: boolean): void {
    if (this.#liveInputActive === active) return;
    this.#liveInputActive = active;
    if (!active) {
      for (const resolve of this.#inputWaiters) resolve();
      this.#inputWaiters.clear();
    }
    if (!this.#terminated) {
      try {
        this.#endpoint.postMessage({
          action: "set-live-input",
          active,
          type: "inkbook-worker-control",
        } satisfies BridgeControl);
      } catch {
        this.#failExecutor("error");
      }
    }
  }

  public terminate(): void {
    if (this.#terminated) return;
    this.#terminated = true;
    for (const message of this.#exportReceipts.values()) this.#acknowledgeExport(message, false);
    this.#exportReceipts.clear();
    this.#endpoint.removeEventListener("message", this.#onMessage);
    this.#endpoint.removeEventListener("error", this.#onError);
    this.#endpoint.terminate();
    this.#rejectAll();
    for (const resolve of this.#inputWaiters) resolve();
    this.#inputWaiters.clear();
  }

  readonly #onMessage = (event: MessageEvent<unknown>): void => {
    if (!isBridgeResponse(event.data)) return;
    const pending = this.#pending.get(event.data.requestId);
    if (pending === undefined) {
      if (event.data.type === "inkbook-worker-result") this.#acknowledgeExport(event.data, false);
      return;
    }
    if (event.data.type === "inkbook-worker-unlock-batch") {
      this.#adoptUnlockBatch(event.data, pending);
      return;
    }
    if (event.data.type === "inkbook-worker-error") {
      this.#settlePending(event.data.requestId, pending);
      pending.reject(new Error(event.data.code));
      this.#failExecutor("error", pending.request);
      return;
    }
    if (pending.resultAdoptionPending) {
      this.#settlePending(event.data.requestId, pending);
      pending.reject(new Error("Document worker returned an invalid result."));
      this.#failExecutor("protocol", pending.request);
      return;
    }
    pending.resultAdoptionPending = true;
    void this.#adoptResult(event.data, pending);
  };

  readonly #onError = (): void => {
    this.#failExecutor("error");
  };

  async #dispatch(
    requestId: number,
    request: DocumentRuntimeRequest,
    pending: PendingBridgeRequest,
  ): Promise<void> {
    try {
      const checkpoint = this.#createMainThreadCheckpoint();
      await checkpoint();
      const encoded = await encodeRuntimeRequestChunked(request, {
        checkpoint,
        signal: pending.abortController.signal,
      });
      pending.abortController.signal.throwIfAborted();
      this.#endpoint.postMessage(
        {
          request: encoded.value,
          requestId,
          type: "inkbook-worker-request",
        } satisfies BridgeRequest,
        [...encoded.transfer],
      );
    } catch {
      if (this.#pending.get(requestId) !== pending) return;
      this.#settlePending(requestId, pending);
      pending.reject(new Error("Document worker request dispatch failed."));
      this.#failExecutor("error", pending.request);
    }
  }

  async #adoptResult(message: BridgeSuccess, pending: PendingBridgeRequest): Promise<void> {
    try {
      const decodeCheckpoint = this.#createMainThreadCheckpoint();
      await decodeCheckpoint();
      const result = await decodeRuntimeResultChunked(message.result, {
        checkpoint: decodeCheckpoint,
        signal: pending.abortController.signal,
      });
      await decodeCheckpoint();
      await assertResultMatchesRequest(pending.request, result, {
        checkpoint: decodeCheckpoint,
        signal: pending.abortController.signal,
      });
      if (!validUnlockCompletion(result, pending)) {
        throw new Error("Unlock batch counts do not match the terminal result.");
      }
      if (this.#pending.get(message.requestId) !== pending) return;
      if (message.result.type === "export-success-wire") {
        const key = exportIdentityKey(message.result);
        const previous = this.#exportReceipts.get(key);
        if (previous !== undefined) this.#acknowledgeExport(previous, false);
        this.#exportReceipts.set(key, message);
      }
      this.#settlePending(message.requestId, pending);
      pending.resolve(result);
    } catch {
      if (this.#pending.get(message.requestId) !== pending) return;
      this.#acknowledgeExport(message, false);
      this.#settlePending(message.requestId, pending);
      pending.reject(new Error("Document worker returned an invalid result."));
      this.#failExecutor("protocol", pending.request);
    }
  }

  #adoptUnlockBatch(message: BridgeUnlockBatch, pending: PendingBridgeRequest): void {
    if (
      !pending.acceptsUnlockBatches ||
      pending.batchAdoptionPending ||
      message.batch.batchIndex !== pending.nextUnlockBatchIndex
    ) {
      this.#finishBatch(message, pending);
      return;
    }
    let batch: UnlockRuntimeBatch;
    try {
      batch = decodeUnlockBatch(message.batch);
    } catch {
      this.#finishBatch(message, pending);
      return;
    }
    if (!matchesUnlockBatchIdentity(batch, pending.request)) {
      this.#finishBatch(message, pending);
      return;
    }
    pending.batchAdoptionPending = true;
    void Promise.resolve(pending.observer?.unlockBatch(batch, pending.abortController.signal)).then(
      () => {
        pending.adoptedElementCount += batch.elements.length;
        pending.batchAdoptionPending = false;
        pending.nextUnlockBatchIndex += 1;
        this.#acknowledgeBatch(message, true);
      },
      () => this.#finishBatch(message, pending),
    );
  }

  #finishBatch(message: BridgeUnlockBatch, pending: PendingBridgeRequest): void {
    this.#acknowledgeBatch(message, false);
    this.#settlePending(message.requestId, pending);
    pending.reject(new Error("Document worker unlock batch adoption failed."));
    this.#failExecutor("protocol", pending.request);
  }

  #settlePending(requestId: number, pending: PendingBridgeRequest): void {
    this.#pending.delete(requestId);
    pending.cancelTimeout?.();
    pending.cancelTimeout = undefined;
    pending.abortController.abort();
  }

  #acknowledgeBatch(message: BridgeUnlockBatch, accepted: boolean): void {
    this.#endpoint.postMessage({
      accepted,
      batchIndex: message.batch.batchIndex,
      requestId: message.requestId,
      type: "inkbook-worker-batch-acknowledgement",
    } satisfies BridgeBatchAcknowledgement);
  }

  #acknowledgeExport(message: BridgeSuccess, accepted: boolean): void {
    if (message.result.type !== "export-success-wire") return;
    this.#endpoint.postMessage({
      accepted,
      exportGeneration: message.result.exportGeneration,
      modelRevision: message.result.modelRevision,
      requestId: message.requestId,
      sessionId: message.result.sessionId,
      type: "inkbook-worker-export-acknowledgement",
      workerEpoch: message.result.workerEpoch,
    } satisfies BridgeExportAcknowledgement);
  }

  #rejectAll(): void {
    for (const pending of this.#pending.values()) {
      pending.cancelTimeout?.();
      pending.cancelTimeout = undefined;
      pending.abortController.abort();
      pending.reject(new Error("Document worker failed."));
    }
    this.#pending.clear();
  }

  #timeoutRequest(requestId: number, pending: PendingBridgeRequest): void {
    if (this.#pending.get(requestId) !== pending) return;
    this.#settlePending(requestId, pending);
    pending.reject(new Error("Document worker request timed out."));
    this.#failExecutor("timeout", pending.request);
  }

  #failExecutor(kind: WorkerRuntimeFailure["kind"], request?: DocumentRuntimeRequest): void {
    if (!this.#terminated) {
      this.#terminated = true;
      this.#endpoint.removeEventListener("message", this.#onMessage);
      this.#endpoint.removeEventListener("error", this.#onError);
      this.#endpoint.terminate();
      this.#rejectAll();
    }
    if (this.#failureReported) return;
    this.#failureReported = true;
    this.#onExecutorFailure?.({ kind, ...(request === undefined ? {} : { request }) });
  }

  #createMainThreadCheckpoint(): () => Promise<void> {
    let sliceStarted = performance.now();
    return async () => {
      while (this.#liveInputActive) {
        await new Promise<void>((resolve) => this.#inputWaiters.add(resolve));
      }
      if (performance.now() - sliceStarted < this.#sliceMilliseconds()) return;
      await yieldToMainThread();
      sliceStarted = performance.now();
    };
  }
}

function exportIdentityKey(identity: ExportIdentity): string {
  return `${identity.sessionId}:${identity.workerEpoch}:${identity.exportGeneration}:${identity.modelRevision}`;
}

function isBridgeResponse(value: unknown): value is BridgeResponse {
  return (
    isObject(value) &&
    (value.type === "inkbook-worker-result" ||
      value.type === "inkbook-worker-error" ||
      value.type === "inkbook-worker-unlock-batch") &&
    Number.isSafeInteger(value.requestId) &&
    ((value.type === "inkbook-worker-error" && value.code === "executor-failed") ||
      (value.type === "inkbook-worker-result" && isDocumentRuntimeWireResult(value.result)) ||
      (value.type === "inkbook-worker-unlock-batch" &&
        isDocumentRuntimeWireUnlockBatch(value.batch)))
  );
}

function validUnlockCompletion(
  result: DocumentRuntimeResult,
  pending: PendingBridgeRequest,
): boolean {
  if (!pending.acceptsUnlockBatches) return result.type !== "unlock-success";
  if (result.type === "runtime-failure") return true;
  return (
    result.type === "unlock-success" &&
    !pending.batchAdoptionPending &&
    result.snapshot.batchCount === pending.nextUnlockBatchIndex &&
    result.snapshot.elementCount === pending.adoptedElementCount
  );
}

function matchesUnlockBatchIdentity(
  batch: UnlockRuntimeBatch,
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function scheduleTimeout(callback: () => void, milliseconds: number): () => void {
  const signal = AbortSignal.timeout(milliseconds);
  const onTimeout = (): void => callback();
  signal.addEventListener("abort", onTimeout, { once: true });
  return () => signal.removeEventListener("abort", onTimeout);
}
