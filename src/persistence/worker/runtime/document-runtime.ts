import { WorkerJobQueue } from "../job-queue";
import { exportIdentityKey, type ExecutorIdentity, type ExportIdentity } from "../protocol";
import { DocumentModelRuntime, RuntimeModelError } from "./document-model";
import { runtimeFailure } from "./runtime-model-error";
import { DocumentPrewarm } from "./document-prewarm";
import { InputActivityGate } from "./input-activity-gate";
import { runClipboardRequest } from "./runtime-clipboard";
import {
  cancelsSpeculativeSceneRequest,
  blocksSpeculativeWork,
  isNavigationSceneRequest,
  isDocumentPrewarmRequest,
  matchesExecutorIdentity,
  matchesRequestExecutor,
  requestJobKind,
  supersedesSpeculativeSceneRequest,
} from "./request-admission";
import { emitUnlockBatches } from "./unlock-batches";
import { ScenePathOperation } from "./scene-path-operation";
import { runtimeSliceContext } from "./slice-scheduler";
import { NavigationJobSuspension } from "./navigation-job-suspension";
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
  readonly #navigationGate = new InputActivityGate(() => this.#navigationActive);
  readonly #navigationSuspension = new NavigationJobSuspension({
    active: () => this.#navigationActive,
    drain: this.#drainJobs.bind(this),
    queue: this.#queue,
    terminated: () => this.#terminated,
  });
  readonly #prewarm: DocumentPrewarm;
  #foreground: Promise<void> | undefined;
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
    this.#model = new DocumentModelRuntime(ownsTransferredSamples);
    this.#prewarm = new DocumentPrewarm(
      this.#model,
      (signal) => this.checkpoint(signal),
      () => this.#mayPrewarm(),
    );
  }
  public get instrumentation() {
    return {
      ...this.#model.instrumentation,
      retainedJobs: this.#jobs.size,
      queuedJobs: this.#queue.pendingCount,
      unacknowledgedExports: this.#unacknowledgedExports.size,
    };
  }
  public execute(
    request: DocumentRuntimeRequest,
    observer?: DocumentRuntimeObserver,
  ): Promise<DocumentRuntimeResult> {
    if (this.#terminated)
      return Promise.reject(new Error("Document worker runtime is terminated."));
    if (!matchesRequestExecutor(request, this.#executor))
      return Promise.resolve(
        runtimeFailure(request, new RuntimeModelError("stale-executor", false)),
      );
    if (this.#unlockPending) {
      return Promise.resolve(runtimeFailure(request, new RuntimeModelError("queue-busy", true)));
    }
    if (supersedesSpeculativeSceneRequest(request)) this.#cancelSpeculativeScenePreparation();
    let sceneOperation: ScenePathOperation | undefined;
    try {
      if (request.type === "prepare-scene-paths") sceneOperation = new ScenePathOperation(request);
    } catch (error) {
      return Promise.resolve(runtimeFailure(request, error));
    }
    const id = `${requestJobKind(request)}:${++this.#nextJobId}`;
    return new Promise((resolve, reject) => {
      const admission = this.#queue.admit({ id, kind: requestJobKind(request), payload: request });
      if (admission !== "accepted") {
        resolve(runtimeFailure(request, new RuntimeModelError(`queue-${admission}`, true)));
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
      this.#navigationSuspension.notify();
      this.#prewarm.interrupt();
      const active = this.#queue.active;
      if (
        blocksSpeculativeWork(request) &&
        active !== null &&
        isDocumentPrewarmRequest(active.payload)
      ) {
        const activeSignal = this.#jobs.get(active.id)?.abortController.signal;
        if (activeSignal !== undefined && !activeSignal.aborted)
          void this.#yieldSpeculative(
            AbortSignal.any([activeSignal, this.#abortController.signal]),
          )?.catch(() => undefined);
      }
      void this.#drain();
    });
  }
  public acknowledgeExport(identity: ExportIdentity, _accepted: boolean): void {
    if (!matchesExecutorIdentity(identity, this.#executor)) return;
    this.#unacknowledgedExports.delete(exportIdentityKey(identity));
    void this.#drain();
    this.#prewarm.schedule();
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
    this.#prewarm.request();
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
    if (!active) this.#prewarm.schedule();
  }
  public setNavigationActive(active: boolean): void {
    this.#navigationActive = active;
    this.#navigationSuspension.notify();
    if (active) this.#cancelSpeculativeScenePreparation(true);
    if (!active) {
      this.#navigationGate.notifyInactive();
      void this.#drain();
      this.#prewarm.schedule();
    }
  }

  #cancelSpeculativeScenePreparation(keepNavigationReserve = false): void {
    for (const [id, job] of this.#jobs)
      if (cancelsSpeculativeSceneRequest(job.request, keepNavigationReserve))
        this.#abortScenePreparation(id, job);
  }

  #abortScenePreparation(id: string, job: PendingJob): void {
    job.abortController.abort();
    if (!this.#queue.cancelPendingRequired(id)) return;
    this.#jobs.delete(id);
    job.resolve(runtimeFailure(job.request, new Error("Scene preparation was cancelled.")));
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
    this.#prewarm.clear();
    this.#onTerminate?.();
  }

  readonly #eligibleJob = (job: import("../protocol").WorkerJob<DocumentRuntimeRequest>): boolean =>
    (!this.#navigationActive ||
      this.#jobs.get(job.id)?.abortController.signal.aborted === true ||
      isNavigationSceneRequest(job.payload)) &&
    (!isDocumentPrewarmRequest(job.payload) || !this.#hasProtectedJobs());

  async #drain(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    await this.#drainJobs(this.#eligibleJob);
    this.#running = false;
    if (!this.#terminated && this.#queue.startNext(this.#eligibleJob) !== null) void this.#drain();
    this.#prewarm.schedule();
  }

  async #drainJobs(
    eligible: (job: import("../protocol").WorkerJob<DocumentRuntimeRequest>) => boolean,
  ): Promise<void> {
    while (!this.#terminated) {
      const active = this.#queue.startNext(eligible);
      if (active === null) break;
      const pending = this.#jobs.get(active.id);
      if (pending === undefined) break;
      const signal = AbortSignal.any([
        this.#abortController.signal,
        pending.abortController.signal,
      ]);
      let result: DocumentRuntimeResult;
      try {
        signal.throwIfAborted();
        result =
          this.#scheduler === null
            ? await this.#run(pending.request, pending.observer, signal)
            : await this.#scheduler.run(
                (signal) => this.#run(pending.request, pending.observer, signal),
                signal,
                isNavigationSceneRequest(pending.request) ? "frame" : undefined,
              );
      } catch (error) {
        result = runtimeFailure(pending.request, error);
      }
      while (isDocumentPrewarmRequest(pending.request) && this.#foreground !== undefined)
        await this.#foreground.catch(() => undefined);
      if (signal.aborted) result = runtimeFailure(pending.request, signal.reason);
      if (!this.#terminated) pending.resolve(result);
      this.#jobs.delete(active.id);
      this.#queue.complete(active.id, eligible);
      if (pending.request.type === "unlock") this.#unlockPending = false;
    }
  }

  #hasProtectedJobs(): boolean {
    return [...this.#jobs.values()].some((job) => blocksSpeculativeWork(job.request));
  }

  #yieldSpeculative(signal: AbortSignal): Promise<void> | undefined {
    if (this.#foreground !== undefined) return this.#foreground;
    if (!this.#hasProtectedJobs()) return undefined;
    signal.throwIfAborted();
    this.#queue.suspendActive();
    this.#foreground = this.#settleForeground(signal);
    return this.#foreground;
  }

  async #settleForeground(signal: AbortSignal): Promise<void> {
    try {
      do {
        const navigation = this.#navigationGate.waitUntilInactive(signal);
        if (navigation !== undefined) await navigation;
        await this.#drainJobs(
          (job) => !isDocumentPrewarmRequest(job.payload) && this.#eligibleJob(job),
        );
      } while (!this.#terminated && this.#hasProtectedJobs());
    } finally {
      this.#foreground = undefined;
      if (!this.#terminated) this.#queue.resumeActive();
    }
    signal.throwIfAborted();
  }

  async #run(
    request: DocumentRuntimeRequest,
    observer: DocumentRuntimeObserver | undefined,
    signal: AbortSignal,
  ): Promise<DocumentRuntimeResult> {
    while (isDocumentPrewarmRequest(request) && this.#foreground !== undefined)
      await this.#foreground.catch(() => undefined);
    signal.throwIfAborted();
    const sliceContext = runtimeSliceContext(
      this.#scheduler,
      signal,
      request,
      () =>
        (!isNavigationSceneRequest(request)
          ? this.#navigationSuspension.wait(signal)
          : undefined) ??
        (isDocumentPrewarmRequest(request) ? this.#yieldSpeculative(signal) : undefined),
    );
    if (request.type === "prepare-scene-paths")
      return this.#prepareScenePaths(request, sliceContext, signal, observer);
    if (request.type === "unlock") return this.#unlock(request, sliceContext, observer);
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
    if (request.type === "verify-output") return this.#verifyOutput(request, sliceContext);
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

  async #verifyOutput(
    request: Extract<DocumentRuntimeRequest, { type: "verify-output" }>,
    context: RuntimeSliceContext | undefined,
  ): Promise<DocumentRuntimeResult> {
    const parsed = await this.#model.verifyOutput(request.input, context, {
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

  async #unlock(
    request: Extract<DocumentRuntimeRequest, { type: "unlock" }>,
    context: RuntimeSliceContext | undefined,
    observer: DocumentRuntimeObserver | undefined,
  ): Promise<DocumentRuntimeResult> {
    let batchCount = 0;
    const unlocked = await this.#model.unlock(
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
                    publish: async (paths, signal) => {
                      while (isDocumentPrewarmRequest(request) && this.#foreground !== undefined)
                        await this.#foreground.catch(() => undefined);
                      signal.throwIfAborted();
                      return observer.scenePaths!(
                        {
                          basisRevision: request.basisRevision,
                          identity: request.identity,
                          paths,
                          type: "prepare-scene-paths-success",
                        },
                        signal,
                      );
                    },
                  }),
            },
      ),
      type: "prepare-scene-paths-success",
    };
  }
  #mayPrewarm(): boolean {
    return (
      !this.#terminated &&
      !this.#liveInputActive &&
      !this.#navigationActive &&
      !this.#running &&
      this.#unacknowledgedExports.size === 0 &&
      this.#queue.active === null &&
      this.#queue.pendingCount === 0
    );
  }
}

const DEFAULT_RUNTIME_SERVICES: DocumentRuntimeServices = Object.freeze({
  createId: () => crypto.randomUUID(),
});
