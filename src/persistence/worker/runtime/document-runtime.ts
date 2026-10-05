import { WorkerJobQueue } from "../job-queue";
import {
  exportIdentityKey,
  type ExecutorIdentity,
  type ExportIdentity,
  type WorkerJobKind,
} from "../protocol";
import { DocumentModelRuntime, RuntimeModelError } from "./document-model";
import { runClipboardRequest } from "./runtime-clipboard";
import { isRequiredSceneRequest, supersedesSpeculativeSceneRequest } from "./request-admission";
import { emitUnlockBatches } from "./unlock-batches";
import { ScenePathOperation } from "./scene-path-operation";
import { runtimeSliceContext } from "./slice-scheduler";
import type {
  DocumentRuntimePort,
  DocumentRuntimeObserver,
  DocumentRuntimeRequest,
  DocumentRuntimeResult,
  DocumentRuntimeServices,
  InputAwareSliceScheduler,
  RuntimeSliceContext,
} from "./types";

interface PendingJob {
  readonly sceneOperation?: ScenePathOperation;
  readonly abortController: AbortController;
  readonly observer: DocumentRuntimeObserver | undefined;
  readonly reject: (reason: unknown) => void;
  readonly request: DocumentRuntimeRequest;
  readonly resolve: (result: DocumentRuntimeResult) => void;
}

export class DocumentWorkerRuntime implements DocumentRuntimePort {
  readonly #abortController = new AbortController();
  readonly #executor: ExecutorIdentity;
  readonly #model: DocumentModelRuntime;
  readonly #jobs = new Map<string, PendingJob>();
  readonly #queue = new WorkerJobQueue<DocumentRuntimeRequest>();
  readonly #unacknowledgedExports = new Map<string, ExportIdentity>();
  readonly #scheduler: InputAwareSliceScheduler | null;
  readonly #services: DocumentRuntimeServices;
  readonly #onTerminate: (() => void) | undefined;
  #nextJobId = 0;
  #liveInputActive = false;
  #navigationActive = false;
  #prewarmRequested = false;
  #prewarmRunning = false;
  #running = false;
  #terminated = false;
  #unlockPending = false;

  public constructor(
    executor: ExecutorIdentity,
    scheduler: InputAwareSliceScheduler | null = null,
    services: DocumentRuntimeServices = DEFAULT_RUNTIME_SERVICES,
    ownsTransferredSamples = false,
    onTerminate?: () => void,
  ) {
    this.#executor = executor;
    this.#scheduler = scheduler;
    this.#services = services;
    this.#onTerminate = onTerminate;
    this.#model = new DocumentModelRuntime(services.now, ownsTransferredSamples);
  }

  public get instrumentation() {
    return {
      ...this.#model.instrumentation,
      unacknowledgedExports: this.#unacknowledgedExports.size,
    };
  }

  public execute(
    request: DocumentRuntimeRequest,
    observer?: DocumentRuntimeObserver,
  ): Promise<DocumentRuntimeResult> {
    if (this.#terminated)
      return Promise.reject(new Error("Document worker runtime is terminated."));
    if (!this.#matchesExecutor(request)) return Promise.resolve(this.#staleResult(request));
    if (this.#unlockPending) {
      return Promise.reject(new Error("Unlock is exclusive until its terminal result."));
    }
    if (supersedesSpeculativeSceneRequest(request)) this.#cancelSpeculativeScenePreparation();
    let sceneOperation: ScenePathOperation | undefined;
    try {
      if (request.type === "prepare-scene-paths") sceneOperation = new ScenePathOperation(request);
    } catch (error) {
      return Promise.resolve(this.#failure(request, error));
    }
    const id = `${this.#kind(request)}:${++this.#nextJobId}`;
    return new Promise((resolve, reject) => {
      const admission = this.#queue.admit({ id, kind: this.#kind(request), payload: request });
      if (admission !== "accepted") {
        reject(new Error(`Document worker queue rejected ${this.#kind(request)}: ${admission}.`));
        return;
      }
      if (request.type === "unlock") this.#unlockPending = true;
      this.#jobs.set(id, {
        ...(sceneOperation === undefined ? {} : { sceneOperation }),
        abortController: new AbortController(),
        observer,
        reject,
        request,
        resolve,
      });
      void this.#drain();
    });
  }

  public acknowledgeExport(identity: ExportIdentity, _accepted: boolean): void {
    if (!this.#matchesExportIdentity(identity)) return;
    this.#unacknowledgedExports.delete(exportIdentityKey(identity));
    this.#schedulePrewarm();
  }
  public cancelScenePreparation(identity: import("../protocol").PurposeOperationIdentity): void {
    for (const [id, job] of this.#jobs) {
      if (job.request.type !== "prepare-scene-paths") continue;
      const candidate = job.request.identity;
      if (
        candidate.sessionId === identity.sessionId &&
        candidate.workerEpoch === identity.workerEpoch &&
        candidate.operationId === identity.operationId &&
        candidate.purpose === identity.purpose
      )
        this.#abortScenePreparation(id, job);
    }
  }

  public retargetScenePreparation(
    identity: import("../protocol").PurposeOperationIdentity,
    ids: readonly string[],
  ): void {
    for (const job of this.#jobs.values())
      if (job.sceneOperation?.matches(identity)) job.sceneOperation.retarget(ids);
  }

  public requestPrewarm(): void {
    if (this.#terminated) return;
    this.#prewarmRequested = true;
    this.#schedulePrewarm();
  }

  public checkpoint(signal: AbortSignal): Promise<void> | undefined {
    signal.throwIfAborted();
    const pending = this.#scheduler?.checkpoint(
      signal === this.#abortController.signal
        ? signal
        : AbortSignal.any([signal, this.#abortController.signal]),
    );
    if (pending !== undefined) return pending.then(() => signal.throwIfAborted());
    signal.throwIfAborted();
    return undefined;
  }

  public setSchedulingProfile(sliceMilliseconds: number, frameIntervalMilliseconds: number): void {
    this.#scheduler?.setSchedulingProfile?.(sliceMilliseconds, frameIntervalMilliseconds);
  }

  public setLiveInputActive(active: boolean): void {
    this.#liveInputActive = active;
    if (active) this.#cancelSpeculativeScenePreparation();
    this.#scheduler?.setLiveInputActive?.(active);
    if (!active) this.#schedulePrewarm();
  }

  public setNavigationActive(active: boolean): void {
    this.#navigationActive = active;
    if (active) this.#cancelSpeculativeScenePreparation();
    if (!active) {
      void this.#drain();
      this.#schedulePrewarm();
    }
  }

  #cancelSpeculativeScenePreparation(): void {
    for (const [id, job] of this.#jobs)
      if (job.request.type === "prepare-scene-paths" && job.request.speculative === true)
        this.#abortScenePreparation(id, job);
  }

  #abortScenePreparation(id: string, job: PendingJob): void {
    job.abortController.abort();
    if (!this.#queue.cancelPendingRequired(id)) return;
    this.#jobs.delete(id);
    job.resolve(this.#failure(job.request, new Error("Scene preparation was cancelled.")));
  }

  public terminate(): void {
    if (this.#terminated) return;
    this.#terminated = true;
    this.#abortController.abort();
    this.#queue.clearPending();
    for (const job of this.#jobs.values())
      job.reject(new Error("Document worker runtime terminated."));
    this.#jobs.clear();
    this.#model.clear();
    this.#unacknowledgedExports.clear();
    this.#prewarmRequested = false;
    this.#onTerminate?.();
  }

  readonly #eligibleJob = (job: import("../protocol").WorkerJob<DocumentRuntimeRequest>): boolean =>
    !this.#navigationActive ||
    this.#jobs.get(job.id)?.abortController.signal.aborted === true ||
    isRequiredSceneRequest(job.payload);

  async #drain(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    while (!this.#terminated) {
      const active = this.#queue.startNext(this.#eligibleJob);
      if (active === null) break;
      const pending = this.#jobs.get(active.id);
      if (pending === undefined) break;
      try {
        const signal = AbortSignal.any([
          this.#abortController.signal,
          pending.abortController.signal,
        ]);
        signal.throwIfAborted();
        const result =
          this.#scheduler === null
            ? await this.#run(pending.request, pending.observer, signal)
            : await this.#scheduler.run(
                (signal) => this.#run(pending.request, pending.observer, signal),
                signal,
                isRequiredSceneRequest(pending.request) ? "frame" : undefined,
              );
        if (!this.#terminated) pending.resolve(result);
      } catch (error) {
        if (!this.#terminated) pending.resolve(this.#failure(pending.request, error));
      }
      this.#jobs.delete(active.id);
      this.#queue.complete(active.id, this.#eligibleJob);
      if (pending.request.type === "unlock") this.#unlockPending = false;
    }
    this.#running = false;
    this.#schedulePrewarm();
  }

  async #run(
    request: DocumentRuntimeRequest,
    observer: DocumentRuntimeObserver | undefined,
    signal: AbortSignal,
  ): Promise<DocumentRuntimeResult> {
    const sliceContext = runtimeSliceContext(this.#scheduler, signal, request);
    if (request.type === "prepare-scene-paths")
      return this.#prepareScenePaths(request, sliceContext, signal, observer);
    if (request.type === "unlock") {
      let batchCount = 0;
      const unlocked = await this.#model.unlock(
        request.input,
        sliceContext,
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
    if (
      request.type === "clipboard-encode" ||
      request.type === "clipboard-decode" ||
      request.type === "clipboard-plan-paste"
    )
      return runClipboardRequest(this.#model, request, sliceContext, () =>
        this.#services.createId(),
      );
    if (request.type === "model-sync-full" || request.type === "model-sync-incremental") {
      this.#model.synchronize(request);
      return {
        identity: request.identity,
        modelRevision: request.modelRevision,
        type: "model-sync-success",
      };
    }
    if (request.type === "verify-output") {
      const parsed = await this.#model.verifyOutput(request.input, sliceContext, {
        ...(request.expectedBytes === undefined ? {} : { expectedBytes: request.expectedBytes }),
        versionPolicy:
          request.versionPolicy ??
          (request.identity.purpose === "read-back" ? "current" : "editable"),
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
    const scheduler = this.#scheduler;
    const result = await this.#model.export(request, scheduler === null ? undefined : sliceContext);
    if (result.ok) {
      this.#unacknowledgedExports.clear();
      this.#unacknowledgedExports.set(exportIdentityKey(request), request);
      return {
        exportGeneration: request.exportGeneration,
        integrityManifest: result.integrityManifest,
        modelRevision: request.modelRevision,
        output: result.output,
        outputHash: result.hash,
        totalBytes: result.totalBytes,
        sessionId: request.sessionId,
        type: "export-success",
        workerEpoch: request.workerEpoch,
      };
    }
    return {
      error: { code: result.code, retryable: result.retryable },
      exportGeneration: request.exportGeneration,
      modelRevision: request.modelRevision,
      sessionId: request.sessionId,
      type: "export-failure",
      workerEpoch: request.workerEpoch,
    };
  }

  async #prepareScenePaths(
    request: Extract<DocumentRuntimeRequest, { type: "prepare-scene-paths" }>,
    context: RuntimeSliceContext | undefined,
    signal: AbortSignal,
    observer: DocumentRuntimeObserver | undefined,
  ): Promise<DocumentRuntimeResult> {
    const operation = [...this.#jobs.values()].find(
      (job) => job.request === request,
    )?.sceneOperation;
    if (request.streamProgress === true && observer?.scenePaths === undefined)
      throw new TypeError("Scene progress requires an observer.");
    return {
      basisRevision: request.basisRevision,
      identity: request.identity,
      paths: await this.#model.prepareScenePaths(
        request,
        context ?? {
          checkpoint: () => undefined,
          signal,
        },
        operation === undefined
          ? undefined
          : {
              operation,
              ...(request.streamProgress !== true || observer?.scenePaths === undefined
                ? {}
                : {
                    publish: (paths, signal) =>
                      observer.scenePaths!(
                        {
                          basisRevision: request.basisRevision,
                          identity: request.identity,
                          paths,
                          type: "prepare-scene-paths-success",
                        },
                        signal,
                      ),
                  }),
            },
      ),
      type: "prepare-scene-paths-success",
    };
  }
  #failure(request: DocumentRuntimeRequest, error: unknown): DocumentRuntimeResult {
    if (request.type === "export-full" || request.type === "export-incremental") {
      return {
        error: {
          code: error instanceof RuntimeModelError ? error.code : "runtime-failure",
          retryable: false,
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

  #staleResult(request: DocumentRuntimeRequest): DocumentRuntimeResult {
    return this.#failure(request, new RuntimeModelError("stale-executor", false));
  }
  #matchesExecutor(request: DocumentRuntimeRequest): boolean {
    const identity =
      request.type === "export-full" || request.type === "export-incremental"
        ? request
        : request.identity;
    return (
      identity.sessionId === this.#executor.sessionId &&
      identity.workerEpoch === this.#executor.workerEpoch
    );
  }
  #matchesExportIdentity(identity: ExecutorIdentity): boolean {
    return (
      identity.sessionId === this.#executor.sessionId &&
      identity.workerEpoch === this.#executor.workerEpoch
    );
  }
  #kind(request: DocumentRuntimeRequest): WorkerJobKind {
    if (request.type === "unlock") return "unlock";
    if (
      request.type === "clipboard-decode" ||
      request.type === "clipboard-encode" ||
      request.type === "clipboard-plan-paste" ||
      request.type === "model-sync-full" ||
      request.type === "model-sync-incremental"
    )
      return "clipboard";
    if (request.type === "export-full" || request.type === "export-incremental") return "export";
    return "required";
  }
  #schedulePrewarm(): void {
    if (
      this.#terminated ||
      this.#prewarmRunning ||
      !this.#prewarmRequested ||
      this.#liveInputActive ||
      this.#navigationActive ||
      this.#running ||
      this.#unacknowledgedExports.size > 0 ||
      this.#queue.active !== null ||
      this.#queue.pendingCount > 0
    ) {
      return;
    }
    this.#prewarmRunning = true;
    const pending = this.checkpoint(this.#abortController.signal);
    void (pending?.then(() => this.#runPrewarm()) ?? this.#runPrewarm()).catch(() => {
      this.#prewarmRunning = false;
    });
  }

  async #runPrewarm(): Promise<void> {
    try {
      while (
        !this.#terminated &&
        this.#prewarmRequested &&
        !this.#liveInputActive &&
        !this.#navigationActive &&
        !this.#running &&
        this.#unacknowledgedExports.size === 0 &&
        this.#queue.pendingCount === 0
      ) {
        const hasMore = await this.#model.prewarmOne({
          checkpoint: () => this.checkpoint(this.#abortController.signal),
          signal: this.#abortController.signal,
        });
        if (!hasMore) {
          this.#prewarmRequested = false;
          break;
        }
      }
    } catch {
      this.#prewarmRequested = false;
    } finally {
      this.#prewarmRunning = false;
      this.#schedulePrewarm();
    }
  }
}

const DEFAULT_RUNTIME_SERVICES: DocumentRuntimeServices = Object.freeze({
  createId: () => crypto.randomUUID(),
  now: () => performance.now(),
});
