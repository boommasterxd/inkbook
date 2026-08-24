import type { InkElementV1 } from "../../../domain/schema/public";
import { WorkerJobQueue } from "../job-queue";
import type { ExecutorIdentity, ExportIdentity, WorkerJobKind } from "../protocol";
import { yieldToMainThread } from "../../scheduling/main-thread-yield";
import { DocumentModelRuntime, RuntimeModelError } from "./document-model";
import type {
  DocumentRuntimePort,
  DocumentRuntimeObserver,
  DocumentRuntimeRequest,
  DocumentRuntimeResult,
  DocumentRuntimeServices,
  InputAwareSliceScheduler,
  RuntimeSliceContext,
  UnlockRuntimeBatch,
} from "./types";
import {
  MAX_UNLOCK_BATCH_ELEMENTS,
  MAX_UNLOCK_BATCH_POINT_BYTES,
  strokePointByteLength,
} from "./unlock-batch-limits";

type ClipboardRuntimeRequest = Extract<
  DocumentRuntimeRequest,
  { type: "clipboard-decode" | "clipboard-encode" | "clipboard-plan-paste" }
>;

interface PendingJob {
  readonly observer: DocumentRuntimeObserver | undefined;
  readonly reject: (reason: unknown) => void;
  readonly request: DocumentRuntimeRequest;
  readonly resolve: (result: DocumentRuntimeResult) => void;
}

const PREWARM_SLICE_MS = 6;

export class DocumentWorkerRuntime implements DocumentRuntimePort {
  readonly #abortController = new AbortController();
  readonly #executor: ExecutorIdentity;
  readonly #model = new DocumentModelRuntime();
  readonly #jobs = new Map<string, PendingJob>();
  readonly #queue = new WorkerJobQueue<DocumentRuntimeRequest>();
  readonly #unacknowledgedExports = new Map<string, ExportIdentity>();
  readonly #scheduler: InputAwareSliceScheduler | null;
  readonly #services: DocumentRuntimeServices;
  #nextJobId = 0;
  #liveInputActive = false;
  #prewarmRequested = false;
  #prewarmRunning = false;
  #running = false;
  #terminated = false;
  #unlockPending = false;

  public constructor(
    executor: ExecutorIdentity,
    scheduler: InputAwareSliceScheduler | null = null,
    services: DocumentRuntimeServices = DEFAULT_RUNTIME_SERVICES,
  ) {
    this.#executor = executor;
    this.#scheduler = scheduler;
    this.#services = services;
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
    const id = `${this.#kind(request)}:${++this.#nextJobId}`;
    return new Promise((resolve, reject) => {
      const admission = this.#queue.admit({ id, kind: this.#kind(request), payload: request });
      if (admission !== "accepted") {
        reject(new Error(`Document worker queue rejected ${this.#kind(request)}: ${admission}.`));
        return;
      }
      if (request.type === "unlock") this.#unlockPending = true;
      this.#jobs.set(id, { observer, reject, request, resolve });
      void this.#drain();
    });
  }

  public acknowledgeExport(identity: ExportIdentity, _accepted: boolean): void {
    if (!this.#matchesExportIdentity(identity)) return;
    this.#unacknowledgedExports.delete(exportIdentityKey(identity));
    this.#schedulePrewarm();
  }

  public requestPrewarm(): void {
    if (this.#terminated) return;
    this.#prewarmRequested = true;
    this.#schedulePrewarm();
  }

  public setLiveInputActive(active: boolean): void {
    this.#liveInputActive = active;
    this.#scheduler?.setLiveInputActive?.(active);
    if (!active) this.#schedulePrewarm();
  }

  public terminate(): void {
    this.#terminated = true;
    this.#abortController.abort();
    this.#queue.clearPending();
    for (const job of this.#jobs.values())
      job.reject(new Error("Document worker runtime terminated."));
    this.#jobs.clear();
    this.#model.clear();
    this.#unacknowledgedExports.clear();
    this.#prewarmRequested = false;
  }

  async #drain(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    while (!this.#terminated) {
      const active = this.#queue.startNext();
      if (active === null) break;
      const pending = this.#jobs.get(active.id);
      if (pending === undefined) break;
      try {
        const result =
          this.#scheduler === null
            ? await this.#run(pending.request, pending.observer, this.#abortController.signal)
            : await this.#scheduler.run(
                (signal) => this.#run(pending.request, pending.observer, signal),
                this.#abortController.signal,
              );
        if (!this.#terminated) pending.resolve(result);
      } catch (error) {
        if (!this.#terminated) pending.resolve(this.#failure(pending.request, error));
      }
      this.#jobs.delete(active.id);
      this.#queue.complete(active.id);
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
    const sliceContext = runtimeSliceContext(this.#scheduler, signal);
    if (request.type === "unlock") {
      let batchCount = 0;
      const unlocked = await this.#model.unlock(request.input, sliceContext, async (snapshot) => {
        batchCount = await emitUnlockBatches(request.identity, snapshot.elements, observer, signal);
      });
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
    if (request.type === "clipboard-encode") {
      return this.#runClipboard(request, sliceContext);
    }
    if (request.type === "clipboard-decode") {
      return this.#runClipboard(request, sliceContext);
    }
    if (request.type === "clipboard-plan-paste") {
      return this.#runClipboard(request, sliceContext);
    }
    if (request.type === "model-sync-full" || request.type === "model-sync-incremental") {
      this.#model.synchronize(request);
      return {
        identity: request.identity,
        modelRevision: request.modelRevision,
        type: "model-sync-success",
      };
    }
    if (request.type === "verify-output") {
      const parsed = await this.#model.verifyOutput(request.input, sliceContext);
      return {
        identity: request.identity,
        persisted:
          parsed !== null
            ? {
                outputHash: parsed.outputHash,
                revision: parsed.revision,
                type: "confirmed",
              }
            : { type: "unreadable" },
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
        modelRevision: request.modelRevision,
        output: result.output,
        outputHash: result.hash,
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

  async #runClipboard(
    request: ClipboardRuntimeRequest,
    context: RuntimeSliceContext | undefined,
  ): Promise<DocumentRuntimeResult> {
    if (request.type === "clipboard-encode") {
      return {
        identity: request.identity,
        result:
          context === undefined
            ? this.#model.encodeClipboard(request.basisRevision, request.selectedIds)
            : await this.#model.encodeClipboardSliced(
                request.basisRevision,
                request.selectedIds,
                context,
              ),
        type: "clipboard-encode-success",
      };
    }
    if (request.type === "clipboard-decode") {
      return {
        identity: request.identity,
        result:
          context === undefined
            ? this.#model.decodeClipboard(request.basisRevision, request.candidates)
            : await this.#model.decodeClipboardSliced(
                request.basisRevision,
                request.candidates,
                context,
              ),
        type: "clipboard-decode-success",
      };
    }
    const createId = (): string => this.#services.createId();
    return {
      identity: request.identity,
      result:
        context === undefined
          ? this.#model.planClipboardPaste(
              request.basisRevision,
              request.candidates,
              request.invocation,
              request.commandTimestamp,
              createId,
              request.previousRepeat,
            )
          : await this.#model.planClipboardPasteSliced(request.basisRevision, request.candidates, {
              commandTimestamp: request.commandTimestamp,
              context,
              createId,
              invocation: request.invocation,
              ...(request.previousRepeat === undefined
                ? {}
                : { previousRepeat: request.previousRepeat }),
            }),
      type: "clipboard-plan-paste-success",
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
      this.#running ||
      this.#unacknowledgedExports.size > 0 ||
      this.#queue.active !== null ||
      this.#queue.pendingCount > 0
    ) {
      return;
    }
    this.#prewarmRunning = true;
    queueMicrotask(() => void this.#runPrewarm());
  }

  async #runPrewarm(): Promise<void> {
    let sliceStarted = performance.now();
    try {
      while (
        !this.#terminated &&
        this.#prewarmRequested &&
        !this.#liveInputActive &&
        !this.#running &&
        this.#queue.pendingCount === 0
      ) {
        const hasMore = await this.#model.prewarmOne({
          checkpoint: async () => {
            this.#abortController.signal.throwIfAborted();
            if (performance.now() - sliceStarted < PREWARM_SLICE_MS) return;
            await yieldToMainThread();
            this.#abortController.signal.throwIfAborted();
            sliceStarted = performance.now();
          },
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

function exportIdentityKey(identity: ExportIdentity): string {
  return `${identity.sessionId}:${identity.workerEpoch}:${identity.exportGeneration}:${identity.modelRevision}`;
}

function runtimeSliceContext(
  scheduler: InputAwareSliceScheduler | null,
  signal: AbortSignal,
): RuntimeSliceContext | undefined {
  return scheduler === null
    ? undefined
    : { checkpoint: () => scheduler.checkpoint(signal), signal };
}

const DEFAULT_RUNTIME_SERVICES: DocumentRuntimeServices = Object.freeze({
  createId: () => crypto.randomUUID(),
});

async function emitUnlockBatches(
  identity: Extract<DocumentRuntimeRequest, { type: "unlock" }>["identity"],
  elements: readonly InkElementV1[],
  observer: DocumentRuntimeObserver | undefined,
  signal: AbortSignal,
): Promise<number> {
  let batchIndex = 0;
  let current: InkElementV1[] = [];
  let currentBytes = 0;
  for (const element of elements) {
    const elementBytes = strokePointByteLength(element);
    if (
      current.length > 0 &&
      (current.length >= MAX_UNLOCK_BATCH_ELEMENTS ||
        currentBytes + elementBytes > MAX_UNLOCK_BATCH_POINT_BYTES)
    ) {
      await emitUnlockBatch({ batchIndex, elements: current, identity }, observer, signal);
      batchIndex += 1;
      current = [];
      currentBytes = 0;
    }
    current.push(element);
    currentBytes += elementBytes;
  }
  if (current.length > 0) {
    await emitUnlockBatch({ batchIndex, elements: current, identity }, observer, signal);
    batchIndex += 1;
  }
  return batchIndex;
}

async function emitUnlockBatch(
  batch: UnlockRuntimeBatch,
  observer: DocumentRuntimeObserver | undefined,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await observer?.unlockBatch(batch, signal);
}
