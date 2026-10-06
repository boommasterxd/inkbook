import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { InputActivityGate } from "./input-activity-gate";
import { ModelPointReferences } from "./model-point-references";
import { scheduleRequestTimeout } from "./request-timeout";
import { isBridgeResponse } from "./bridge-response-validation";
import { ScenePathReceiver } from "./scene-path-receiver";
import { createMainThreadRequestCheckpoint } from "./slice-scheduler";
import {
  acknowledgePathBatch,
  controlScenePreparation,
  cancelSpeculativeScenePreparations,
} from "./scene-bridge-control";
import type {
  DocumentRuntimeObserver,
  DocumentRuntimePort,
  DocumentRuntimeRequest,
  DocumentRuntimeResult,
  UnlockRuntimeBatch,
} from "./types";
import { exportIdentityKey, type ExportIdentity } from "../protocol";
import {
  decodeUnlockBatch,
  decodeRuntimeResultChunked,
  encodeRuntimeRequestChunked,
} from "./wire-codec";
import { matchesUnlockBatchIdentity, validUnlockCompletion } from "./request-result-validation";
import { supersedesSpeculativeSceneRequest } from "./request-admission";
import type {
  BridgeControl,
  BridgeExportAcknowledgement,
  BridgeRequest,
  BridgeSuccess,
  BridgeUnlockBatch,
  BridgeScenePaths,
} from "./bridge-messages";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
import type {
  WorkerBridgeEndpoint,
  WorkerRuntimeFailure,
  WorkerDocumentRuntimePortOptions,
} from "./worker-bridge-contracts";
export type {
  WorkerBridgeEndpoint,
  WorkerRuntimeFailure,
  WorkerDocumentRuntimePortOptions,
} from "./worker-bridge-contracts";

interface PendingBridgeRequest {
  readonly sceneReceiver: ScenePathReceiver;
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
export class WorkerDocumentRuntimePort implements DocumentRuntimePort {
  readonly #endpoint: WorkerBridgeEndpoint;
  readonly #pointReferences = new ModelPointReferences();
  readonly #onExecutorFailure: ((failure: WorkerRuntimeFailure) => void) | undefined;
  readonly #pending = new Map<number, PendingBridgeRequest>();
  readonly #exportReceipts = new Map<string, BridgeSuccess>();
  readonly #requestTimeoutMilliseconds: number;
  readonly #frameIntervalMilliseconds: () => number;
  readonly #workScheduler: WorkScheduler;
  readonly #inputGate = new InputActivityGate(() => this.#liveInputActive);
  readonly #navigationGate = new InputActivityGate(() => this.#navigationActive);
  readonly #unsubscribeSchedulingProfile: (() => void) | undefined;
  #publishedProfile: string | undefined;
  #failureReported = false;
  #liveInputActive = false;
  #navigationActive = false;
  #nextRequestId = 0;
  #terminated = false;

  public constructor(
    createWorker: () => WorkerBridgeEndpoint,
    options: WorkerDocumentRuntimePortOptions,
  ) {
    const timeout = options.requestTimeoutMilliseconds ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!(timeout > 0) || !Number.isFinite(timeout))
      throw new RangeError("requestTimeoutMilliseconds must be a positive finite number.");
    this.#requestTimeoutMilliseconds = timeout;
    this.#workScheduler = options.workScheduler;
    this.#frameIntervalMilliseconds = options.frameIntervalMilliseconds;
    this.#onExecutorFailure = options.onExecutorFailure;
    this.#endpoint = createWorker();
    this.#endpoint.addEventListener("message", this.#onMessage);
    this.#endpoint.addEventListener("error", this.#onError);
    this.#unsubscribeSchedulingProfile = options.subscribeSchedulingProfile?.(() =>
      this.notifySchedulingProfileChanged(),
    );
  }

  public execute(
    request: DocumentRuntimeRequest,
    observer?: DocumentRuntimeObserver,
  ): Promise<DocumentRuntimeResult> {
    if (ScenePathReceiver.needsObserver(request, observer))
      return Promise.reject(new TypeError("Scene progress requires an observer."));
    if (this.#terminated) return Promise.reject(new Error("Document worker port is terminated."));
    const requestId = ++this.#nextRequestId;
    return new Promise((resolve, reject) => {
      try {
        if (supersedesSpeculativeSceneRequest(request))
          cancelSpeculativeScenePreparations(this.#endpoint, this.#pending);
      } catch {
        this.#failExecutor("error", request);
        reject(new Error("Document worker request dispatch failed."));
        return;
      }
      const sceneReceiver = new ScenePathReceiver(request);
      request = sceneReceiver.request ?? request;
      const pending: PendingBridgeRequest = {
        sceneReceiver,
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
      pending.cancelTimeout = scheduleRequestTimeout(
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
      this.#publishSchedulingProfile();
      this.#endpoint.postMessage({
        action: "prewarm",
        type: "inkbook-worker-control",
      } satisfies BridgeControl);
    } catch {
      this.#failExecutor("error");
    }
  }
  public cancelScenePreparation(identity: import("../protocol").PurposeOperationIdentity): void {
    if (!this.#terminated) controlScenePreparation(this.#endpoint, this.#pending, identity);
  }

  public notifySchedulingProfileChanged(): void {
    if (this.#terminated) return;
    try {
      this.#publishSchedulingProfile();
    } catch {
      this.#failExecutor("error");
    }
  }

  public retargetScenePreparation(
    identity: import("../protocol").PurposeOperationIdentity,
    ids: readonly string[],
  ): void {
    if (!this.#terminated) controlScenePreparation(this.#endpoint, this.#pending, identity, ids);
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
    if (!active) this.#inputGate.notifyInactive();
    if (!this.#terminated) {
      try {
        if (active) cancelSpeculativeScenePreparations(this.#endpoint, this.#pending);
        this.#publishSchedulingProfile();
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

  public setNavigationActive(active: boolean): void {
    if (this.#terminated || this.#navigationActive === active) return;
    this.#navigationActive = active;
    if (!active) this.#navigationGate.notifyInactive();
    try {
      if (active) cancelSpeculativeScenePreparations(this.#endpoint, this.#pending, true);
      this.#endpoint.postMessage({
        action: "set-navigation",
        active,
        type: "inkbook-worker-control",
      } satisfies BridgeControl);
    } catch {
      this.#failExecutor("error");
    }
  }

  public terminate(): void {
    if (this.#terminated) return;
    for (const message of this.#exportReceipts.values()) this.#acknowledgeExport(message, false);
    this.#close();
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
    if (event.data.type === "inkbook-worker-scene-paths") {
      this.#adoptScenePaths(event.data, pending);
      return;
    }
    if (event.data.type === "inkbook-worker-error") {
      this.#settlePending(event.data.requestId, pending);
      pending.reject(new Error(event.data.code));
      this.#failExecutor("error", pending.request);
      return;
    }
    if (pending.resultAdoptionPending || pending.sceneReceiver.waiting) {
      this.#settlePending(event.data.requestId, pending);
      pending.reject(new Error("Document worker returned an invalid result."));
      this.#failExecutor("protocol", pending.request);
      return;
    }
    pending.resultAdoptionPending = true;
    void this.#adoptResult(event.data, pending);
  };

  readonly #onError = (): void => this.#failExecutor("error");

  async #dispatch(
    requestId: number,
    request: DocumentRuntimeRequest,
    pending: PendingBridgeRequest,
  ): Promise<void> {
    try {
      if (request.type === "unlock") this.#pointReferences.clear();
      const checkpoint = this.#createMainThreadCheckpoint(pending.abortController.signal, request);
      const admission = checkpoint();
      if (admission !== undefined) await admission;
      const encoded = await encodeRuntimeRequestChunked(request, {
        checkpoint,
        signal: pending.abortController.signal,
        reusePoints: this.#pointReferences.encoder(request),
      });
      pending.abortController.signal.throwIfAborted();
      this.#publishSchedulingProfile();
      this.#endpoint.postMessage(
        {
          request: encoded.value,
          requestId,
          type: "inkbook-worker-request",
        } satisfies BridgeRequest,
        [...encoded.transfer],
      );
      if (request.type === "prepare-scene-paths" && pending.sceneReceiver.retainedIds !== undefined)
        this.retargetScenePreparation(request.identity, pending.sceneReceiver.retainedIds);
    } catch {
      if (this.#pending.get(requestId) !== pending) return;
      this.#settlePending(requestId, pending);
      pending.reject(new Error("Document worker request dispatch failed."));
      this.#failExecutor("error", pending.request);
    }
  }

  async #adoptResult(message: BridgeSuccess, pending: PendingBridgeRequest): Promise<void> {
    try {
      const decodeCheckpoint = this.#createMainThreadCheckpoint(
        pending.abortController.signal,
        pending.request,
        true,
      );
      const admission = decodeCheckpoint();
      if (admission !== undefined) await admission;
      const result = await decodeRuntimeResultChunked(message.result, {
        checkpoint: decodeCheckpoint,
        signal: pending.abortController.signal,
      });
      const verificationAdmission = decodeCheckpoint();
      if (verificationAdmission !== undefined) await verificationAdmission;
      await pending.sceneReceiver.validateResult(pending.request, result, {
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
      this.#pointReferences.accept(pending.request, result);
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
      if (!matchesUnlockBatchIdentity(message.batch, pending.request)) {
        this.#finishBatch(message, pending);
        return;
      }
      batch = decodeUnlockBatch(message.batch);
    } catch {
      this.#finishBatch(message, pending);
      return;
    }
    pending.batchAdoptionPending = true;
    void Promise.resolve(pending.observer?.unlockBatch(batch, pending.abortController.signal)).then(
      () => {
        if (!this.#isPending(message.requestId, pending)) return;
        this.#pointReferences.stageUnlock(batch);
        pending.adoptedElementCount += batch.elements.length;
        pending.batchAdoptionPending = false;
        pending.nextUnlockBatchIndex += 1;
        acknowledgePathBatch(this.#endpoint, message, true);
      },
      () => this.#finishBatch(message, pending),
    );
  }

  #adoptScenePaths(message: BridgeScenePaths, pending: PendingBridgeRequest): void {
    const checkpoint = this.#createMainThreadCheckpoint(
      pending.abortController.signal,
      pending.request,
      true,
    );
    void pending.sceneReceiver
      .adopt(message, pending.request, pending.observer, pending.abortController.signal, checkpoint)
      .then(
        () => {
          if (this.#isPending(message.requestId, pending))
            acknowledgePathBatch(this.#endpoint, message, true);
        },
        () => {
          if (!this.#isPending(message.requestId, pending)) return;
          acknowledgePathBatch(this.#endpoint, message, false);
          this.#settlePending(message.requestId, pending);
          pending.reject(new Error("Document worker scene path adoption failed."));
          this.#failExecutor("protocol", pending.request);
        },
      );
  }

  #finishBatch(message: BridgeUnlockBatch, pending: PendingBridgeRequest): void {
    if (!this.#isPending(message.requestId, pending)) return;
    acknowledgePathBatch(this.#endpoint, message, false);
    this.#settlePending(message.requestId, pending);
    pending.reject(new Error("Document worker unlock batch adoption failed."));
    this.#failExecutor("protocol", pending.request);
  }

  #isPending(requestId: number, pending: PendingBridgeRequest): boolean {
    return this.#pending.get(requestId) === pending && !pending.abortController.signal.aborted;
  }

  #settlePending(requestId: number, pending: PendingBridgeRequest): void {
    this.#pending.delete(requestId);
    pending.cancelTimeout?.();
    pending.cancelTimeout = undefined;
    pending.abortController.abort();
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
    if (!this.#terminated) this.#close();
    if (this.#failureReported) return;
    this.#failureReported = true;
    this.#onExecutorFailure?.({ kind, ...(request === undefined ? {} : { request }) });
  }

  #close(): void {
    this.#terminated = true;
    this.#exportReceipts.clear();
    this.#endpoint.removeEventListener("message", this.#onMessage);
    this.#endpoint.removeEventListener("error", this.#onError);
    this.#unsubscribeSchedulingProfile?.();
    this.#endpoint.terminate();
    this.#pointReferences.clear();
    this.#rejectAll();
    this.#inputGate.notifyInactive();
    this.#navigationGate.notifyInactive();
  }

  #createMainThreadCheckpoint(
    signal: AbortSignal,
    request: DocumentRuntimeRequest,
    adoption = false,
  ): () => Promise<void> | undefined {
    return createMainThreadRequestCheckpoint(
      {
        inputGate: this.#inputGate,
        navigationGate: this.#navigationGate,
        scheduler: this.#workScheduler,
      },
      signal,
      request,
      adoption,
    );
  }
  #publishSchedulingProfile(): void {
    if (this.#terminated) return;
    const sliceMilliseconds = this.#workScheduler.budgetMs();
    const frameIntervalMilliseconds = this.#frameIntervalMilliseconds();
    if (
      !Number.isFinite(sliceMilliseconds) ||
      sliceMilliseconds <= 0 ||
      !Number.isFinite(frameIntervalMilliseconds) ||
      frameIntervalMilliseconds <= 0
    ) {
      throw new RangeError("Worker scheduling profile must contain positive finite times.");
    }
    const profile = `${sliceMilliseconds}:${frameIntervalMilliseconds}`;
    if (profile === this.#publishedProfile) return;
    this.#endpoint.postMessage({
      action: "set-profile",
      frameIntervalMilliseconds,
      sliceMilliseconds,
      type: "inkbook-worker-control",
    } satisfies BridgeControl);
    this.#publishedProfile = profile;
  }
}
