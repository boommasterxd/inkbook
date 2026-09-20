import { nextSafeCounter } from "../../worker/identity";
import type { ExportSuccess, PurposeOperationIdentity, VaultBase } from "../../worker/protocol";
import type { DocumentRuntimeResult, ModelSyncRuntimeRequest } from "../../worker/runtime/public";
import { readExistingFileWithinLimit } from "../bounded-file-read";
import type { PreparedSave } from "../save-existing";
import {
  AutosaveExportIntegrity,
  inspectIntegrityBoundExport,
  type ExportIntegrityDecision,
} from "./export-integrity";
import type * as Autosave from "./types";
import {
  createExportRequest,
  createModelSyncRequest,
  matchesExportResult,
  matchesModelSyncResult,
  type ConcreteExportRequest,
} from "./export-request";
import { persistPreparedOutput, resolveAutosaveExpectedBase } from "./save-operation";
import { createTerminalVaultPort } from "./terminal-vault-port";
import { AutosavePersistedOutputVerifier } from "./persisted-output-verifier";
import { notifyConfirmedPersistence } from "./confirmed-persistence";
import { AutosaveWorkerModelState } from "./worker-model-state";
import { isAutosaveSuspended, terminalAutosaveOutcome } from "./status";
import { ACTIVE_GESTURE_RETRY_MS, AUTOSAVE_DELAY_MS, AutosaveTimer } from "./timer";
import { assertAutosaveInitialState } from "./coordinator-validation";
import { inspectAutosaveExternalChange } from "./external-change";
import { inspectIndeterminateSave } from "./indeterminate-save";
import { classifyAutosaveFailure } from "./save-failure";

export class AutosaveCoordinator {
  readonly #beforeExistingWrite;
  #canonicalRewritePending: boolean;
  #confirmedBase: VaultBase;
  #confirmedContent: string | null;
  readonly #createFallback;
  readonly #document;
  #disposed = false;
  #executor;
  #exportGeneration = 0;
  #exportInFlight: ConcreteExportRequest | null = null;
  #fallbackUsed = false;
  #forced = false;
  readonly #integrity;
  #modelSyncInFlight: ModelSyncRuntimeRequest | null = null;
  readonly #observer;
  readonly #path;
  #prepared: ExportSuccess | null = null;
  #save: Autosave.ActiveAutosave | null = null;
  #saveOperationId = 0;
  #savePromise: Promise<void> | null = null;
  readonly #sessionId;
  #status: Autosave.AutosaveStatus;
  readonly #timer;
  readonly #terminalVault;
  readonly #waiters: Autosave.FlushWaiter[] = [];
  #workerEpoch;
  readonly #verifier;
  readonly #workerModel;
  public constructor(options: Autosave.AutosaveCoordinatorOptions) {
    assertAutosaveInitialState(options);
    this.#integrity = new AutosaveExportIntegrity(options.waitForBackground);
    this.#confirmedContent = options.confirmedContent ?? null;
    this.#beforeExistingWrite = options.beforeExistingWrite;
    this.#canonicalRewritePending = options.requiresCanonicalRewrite ?? false;
    this.#confirmedBase = options.confirmedBase;
    this.#createFallback = options.createFallback;
    this.#document = options.documentSource;
    this.#executor = options.executor;
    this.#observer = options.observer;
    this.#path = options.path;
    this.#sessionId = options.sessionId;
    this.#status = this.dirty ? "debouncing" : "clean";
    this.#timer = new AutosaveTimer(options.clock, () => this.#kick());
    this.#terminalVault = createTerminalVaultPort(options.vault, () => this.#disposed);
    this.#workerEpoch = options.workerEpoch ?? 0;
    this.#workerModel = new AutosaveWorkerModelState(options.initialSnapshot.revision);
    if (this.#canonicalRewritePending) {
      this.#workerModel.requireFull(options.initialSnapshot.revision);
      this.#timer.schedule(AUTOSAVE_DELAY_MS);
    }
    this.#verifier = new AutosavePersistedOutputVerifier({
      ...(options.waitForBackground ? { waitForBackground: options.waitForBackground } : {}),
      executor: () => this.#executor,
      isDisposed: () => this.#disposed,
      sessionId: this.#sessionId,
      switchToFallback: () => this.#switchToFallback(),
      workerEpoch: () => this.#workerEpoch,
    });
  }
  public get dirty(): boolean {
    return (
      this.#canonicalRewritePending ||
      this.#confirmedBase.type === "missing" ||
      this.#confirmedBase.revision !== this.#document.currentRevision()
    );
  }
  public get status(): Autosave.AutosaveStatus {
    return this.#status;
  }
  public get retainedConfirmedContentBytes(): number {
    return this.#confirmedContent?.length ?? 0;
  }
  public recordCommit(delta: Autosave.AutosaveDelta): void {
    if (this.#disposed) return;
    if (delta.modelRevision !== this.#document.currentRevision()) {
      throw new RangeError("Autosave delta must describe the current document revision.");
    }
    this.#workerModel.record(
      delta,
      this.#modelSyncInFlight?.modelRevision ?? this.#exportInFlight?.modelRevision,
    );
    if (this.#prepared !== null && this.#prepared.modelRevision !== delta.modelRevision)
      this.#prepared = null;
    this.#forced = false;
    if (isAutosaveSuspended(this.#status)) return;
    this.#setStatus("debouncing");
    this.#timer.schedule(AUTOSAVE_DELAY_MS);
  }
  public async synchronizeWorkerBaseline(identity: PurposeOperationIdentity): Promise<boolean> {
    const revision = this.#document.currentRevision();
    if (this.#disposed || isAutosaveSuspended(this.#status)) return false;
    if (
      this.#workerModel.modelRevision === revision &&
      !this.#workerModel.requiresFullSynchronization
    ) {
      return true;
    }
    if (this.#exportInFlight !== null || this.#modelSyncInFlight !== null) return false;
    const plan = this.#workerModel.takePlan(this.#document);
    if (plan === null || plan.modelRevision !== revision) return false;
    const request = createModelSyncRequest(plan, identity);
    this.#modelSyncInFlight = request;
    let synchronized = false;
    try {
      const result = await this.#executor.execute(request);
      if (
        this.#disposed ||
        this.#modelSyncInFlight !== request ||
        !matchesModelSyncResult(request, result)
      ) {
        return false;
      }
      this.#workerModel.acknowledgeSynchronization(result.modelRevision);
      synchronized = true;
      return result.modelRevision === this.#document.currentRevision();
    } catch {
      if (!this.#disposed && this.#modelSyncInFlight === request) this.#switchToFallback();
      return false;
    } finally {
      if (!this.#disposed && this.#modelSyncInFlight === request) {
        this.#modelSyncInFlight = null;
        if (!synchronized) this.#requireFullSnapshot();
        if (this.#forced || !this.#timer.hasPending) this.#kick();
      }
    }
  }
  public recoverWorkerExecutor(): boolean {
    if (this.#disposed || !this.#switchToFallback()) return false;
    this.#prepared = null;
    this.#requireFullSnapshot();
    return true;
  }
  public flush(_reason: Autosave.FlushReason): Promise<Autosave.FlushOutcome> {
    if (this.#disposed) return Promise.resolve(terminalAutosaveOutcome(this.dirty, this.#status));
    if (!this.dirty) return Promise.resolve("clean");
    this.#forced = true;
    this.#timer.clear();
    const promise = new Promise<Autosave.FlushOutcome>((resolve) =>
      this.#waiters.push({ resolve }),
    );
    this.#kick();
    return promise;
  }
  public async retryVerification(): Promise<Autosave.FlushOutcome> {
    if (this.#disposed) return terminalAutosaveOutcome(this.dirty, this.#status);
    const active = this.#save;
    if (this.#status !== "verification-required" || active === null) {
      return terminalAutosaveOutcome(this.dirty, this.#status);
    }
    try {
      const inspected = await inspectIndeterminateSave({
        activeOutputHash: active.proof.outputHash,
        activeRevision: active.proof.revision,
        previousBase: active.previousBase,
        read: () => readExistingFileWithinLimit(this.#terminalVault, this.#path),
        stopped: () => this.#disposed,
        verify: (content) => this.#verifier.verify(content, "verification"),
      });
      this.#adoptIndeterminateSaveInspection(inspected);
    } catch {
      this.#setStatus("executor-failed");
    }
    if (this.dirty && !isAutosaveSuspended(this.#status) && this.#forced) this.#kick();
    return terminalAutosaveOutcome(this.dirty, this.#status);
  }
  public async notifyExternalChange(): Promise<Autosave.ExternalChangeOutcome> {
    if (this.#disposed) return "conflict";
    const inspected = await inspectAutosaveExternalChange({
      activeSaveBase: () =>
        this.#save === null
          ? undefined
          : {
              outputHash: this.#save.proof.outputHash,
              revision: this.#save.proof.revision,
              type: "confirmed",
            },
      confirmedBase: this.#confirmedBase,
      currentRevision: () => this.#document.currentRevision(),
      dirty: () => this.dirty,
      read: () => readExistingFileWithinLimit(this.#terminalVault, this.#path),
      stopped: () => this.#disposed,
      verify: (content) => this.#verifier.verify(content, "preflight"),
    });
    if (inspected.outcome === "conflict") {
      this.#setStatus("conflict");
      this.#resolveWaiters();
    }
    if (inspected.outcome === "reload-required") {
      this.#confirmedBase = inspected.confirmedBase;
      this.#confirmedContent = null;
    }
    return inspected.outcome;
  }
  public dispose(mode: "preserve-executor" | "terminal" = "terminal"): void {
    if (
      mode === "preserve-executor" &&
      (this.#savePromise !== null || this.#exportInFlight !== null)
    ) {
      throw new Error("Autosave work must settle before preserving its executor.");
    }
    if (this.#disposed) return;
    this.#disposed = true;
    this.#timer.clear();
    this.#exportInFlight = null;
    this.#modelSyncInFlight = null;
    this.#workerModel.clear();
    this.#prepared = null;
    if (this.#save !== null) this.#save.result = null;
    this.#save = null;
    this.#forced = false;
    if (mode === "terminal") this.#executor.terminate();
    this.#setStatus("executor-failed");
    this.#resolveWaiters();
  }
  #kick(): void {
    if (this.#disposed) {
      this.#resolveWaiters();
      return;
    }
    if (!this.dirty || isAutosaveSuspended(this.#status)) {
      this.#resolveWaiters();
      return;
    }
    if (this.#document.isGestureActive()) {
      this.#setStatus("waiting-for-gesture");
      this.#timer.schedule(ACTIVE_GESTURE_RETRY_MS);
      return;
    }
    this.#dispatchExport();
    this.#startPreparedSave();
  }
  #dispatchExport(): void {
    if (this.#disposed || this.#exportInFlight !== null || this.#modelSyncInFlight !== null) return;
    const plan = this.#workerModel.takePlan(this.#document);
    if (plan === null) return;
    this.#exportGeneration = nextSafeCounter(this.#exportGeneration, "exportGeneration");
    const identity = {
      exportGeneration: this.#exportGeneration,
      sessionId: this.#sessionId,
      workerEpoch: this.#workerEpoch,
    };
    const request = createExportRequest(plan, identity);
    this.#exportInFlight = request;
    this.#setStatus("saving");
    void this.#executor.execute(request).then(
      (result) => void this.#adoptExport(request, result),
      () => this.#recoverExecutor(request),
    );
  }
  async #adoptExport(request: ConcreteExportRequest, result: DocumentRuntimeResult): Promise<void> {
    if (this.#disposed || this.#exportInFlight !== request) {
      if (result.type === "export-success") this.#executor.acknowledgeExport?.(result, false);
      return;
    }
    if (result.type !== "export-success" || !matchesExportResult(request, result)) {
      this.#exportInFlight = null;
      if (result.type === "export-success") this.#executor.acknowledgeExport?.(result, false);
      if (result.type === "export-failure" && matchesExportResult(request, result))
        this.#requireFullSnapshot();
      this.#setStatus("retryable-error");
      this.#resolveWaiters();
      return;
    }
    const integrity = await this.#integrity.verify(
      () => this.#document.snapshot(),
      result.integrityManifest,
      undefined,
      () =>
        !this.#disposed &&
        this.#exportInFlight === request &&
        result.modelRevision === this.#document.currentRevision(),
    );
    this.#adoptExportIntegrity(request, result, integrity);
  }
  #adoptExportIntegrity(
    request: ConcreteExportRequest,
    result: ExportSuccess,
    integrity: ExportIntegrityDecision,
  ): void {
    if (this.#disposed || this.#exportInFlight !== request) {
      this.#executor.acknowledgeExport?.(result, false);
      return;
    }
    this.#exportInFlight = null;
    if (result.modelRevision !== this.#document.currentRevision()) {
      this.#workerModel.acknowledgeExport(result.modelRevision);
      this.#executor.acknowledgeExport?.(result, false);
      if (this.#forced || !this.#timer.hasPending) this.#kick();
      return;
    }
    if (integrity !== "match") {
      this.#executor.acknowledgeExport?.(result, false);
      this.#prepared = null;
      if (integrity === "retry-full") {
        this.#requireFullSnapshot();
        this.#setStatus("debouncing");
        this.#kick();
      } else {
        this.#switchToFallback();
        this.#setStatus("executor-failed");
        this.#resolveWaiters();
      }
      return;
    }
    this.#workerModel.acknowledgeExport(result.modelRevision);
    this.#executor.acknowledgeExport?.(result, true);
    this.#prepared = result;
    this.#startPreparedSave();
    if (this.#forced) this.#kick();
  }
  #startPreparedSave(): void {
    const prepared = this.#prepared;
    if (
      this.#disposed ||
      prepared === null ||
      this.#savePromise !== null ||
      prepared.modelRevision !== this.#document.currentRevision() ||
      prepared.workerEpoch !== this.#workerEpoch
    )
      return;
    this.#prepared = null;
    this.#saveOperationId = nextSafeCounter(this.#saveOperationId, "saveOperationId");
    this.#save = {
      previousBase: this.#confirmedBase,
      previousContent: this.#confirmedContent,
      proof: {
        outputHash: prepared.outputHash,
        revision: prepared.modelRevision,
        saveOperationId: this.#saveOperationId,
      },
      result: prepared,
    };
    this.#savePromise = this.#persist(this.#save);
  }
  async #persist(active: Autosave.ActiveAutosave): Promise<void> {
    const result = active.result;
    if (result === null) throw new Error("Active save output was already released.");
    let outputTrusted = false;
    try {
      const trusted = await inspectIntegrityBoundExport(result, this.#integrity.waitForBackground);
      active.result = null;
      if (this.#disposed) return;
      outputTrusted = true;
      const prepared: Omit<PreparedSave, "expectedBase"> = {
        output: trusted.content,
        outputHash: trusted.outputHash,
        path: this.#path,
        revision: result.modelRevision,
      };
      const expectedBase = await resolveAutosaveExpectedBase({
        confirmedBase: active.previousBase,
        confirmedContent: active.previousContent,
        read: () => readExistingFileWithinLimit(this.#terminalVault, this.#path),
        verify: (content) => this.#verifier.verify(content, "preflight"),
      });
      if (this.#disposed) return;
      const confirmed = await persistPreparedOutput({
        beforeExistingWrite: this.#beforeExistingWrite,
        expectedBase,
        prepared,
        revisionSource: {
          currentRevision: () => this.#document.currentRevision(),
          ...(this.#integrity.waitForBackground
            ? { waitForBackground: this.#integrity.waitForBackground }
            : {}),
        },
        vault: this.#terminalVault,
        verifier: {
          verify: (content, revision, hash) =>
            this.#verifier.verifyExpected(content, revision, hash),
        },
      });
      if (this.#disposed) return;
      this.#confirmSavedOutput({
        outputHash: confirmed.outputHash,
        revision: confirmed.revision,
        type: "confirmed",
      });
      this.#resolveWaiters();
    } catch (error) {
      active.result = null;
      if (!this.#disposed) {
        if (outputTrusted) this.#handleSaveFailure(error);
        else this.#handleUntrustedExport(active);
      }
    } finally {
      this.#savePromise = null;
      if (!this.#disposed && this.dirty && !isAutosaveSuspended(this.#status)) this.#kick();
    }
  }
  #handleUntrustedExport(active: Autosave.ActiveAutosave): void {
    if (this.#save === active) this.#save = null;
    this.#requireFullSnapshot();
    if (this.#switchToFallback()) this.#setStatus("debouncing");
  }
  #handleSaveFailure(error: unknown): void {
    const status = classifyAutosaveFailure(error);
    if (status !== "verification-required") this.#save = null;
    this.#setStatus(status);
    if (status !== "debouncing") this.#resolveWaiters();
  }
  #adoptIndeterminateSaveInspection(
    inspected: Awaited<ReturnType<typeof inspectIndeterminateSave>>,
  ): void {
    if (inspected?.outcome === "confirmed") {
      this.#confirmSavedOutput(inspected.confirmedBase);
    } else if (inspected?.outcome === "retryable-error") {
      this.#save = null;
      this.#requireFullSnapshot();
      this.#setStatus("retryable-error");
    } else if (inspected?.outcome === "conflict") {
      this.#save = null;
      this.#setStatus("conflict");
    }
    this.#resolveWaiters();
  }
  #confirmSavedOutput(base: Extract<VaultBase, { type: "confirmed" }>): void {
    this.#confirmedBase = base;
    this.#confirmedContent = null;
    this.#canonicalRewritePending = false;
    this.#save = null;
    notifyConfirmedPersistence(this.#observer, this.#path, base);
    this.#executor.requestPrewarm?.();
    this.#setStatus(this.dirty ? "debouncing" : "clean");
  }
  #recoverExecutor(request: ConcreteExportRequest): void {
    if (this.#disposed || this.#exportInFlight !== request) return;
    this.#exportInFlight = null;
    if (!this.#switchToFallback()) return;
    this.#prepared = null;
    this.#requireFullSnapshot();
    this.#kick();
  }
  #requireFullSnapshot(): void {
    this.#workerModel.requireFull(
      this.#document.currentRevision(),
      this.#modelSyncInFlight?.modelRevision ?? this.#exportInFlight?.modelRevision,
    );
  }
  #setStatus(status: Autosave.AutosaveStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#observer?.statusChanged(status);
  }
  #resolveWaiters(): void {
    if (this.dirty && !isAutosaveSuspended(this.#status) && this.#status !== "retryable-error")
      return;
    const outcome = terminalAutosaveOutcome(this.dirty, this.#status);
    for (const waiter of this.#waiters.splice(0)) waiter.resolve(outcome);
  }
  #switchToFallback(): boolean {
    if (this.#disposed) return false;
    if (this.#fallbackUsed || this.#createFallback === undefined) {
      this.#setStatus("executor-failed");
      this.#resolveWaiters();
      return false;
    }
    this.#fallbackUsed = true;
    this.#executor.terminate();
    this.#workerEpoch = nextSafeCounter(this.#workerEpoch, "workerEpoch");
    this.#executor = this.#createFallback(this.#workerEpoch);
    this.#verifier.resetOperationIdentities();
    return true;
  }
}
