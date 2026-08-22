import { nextSafeCounter } from "../../worker/identity";
import type {
  ExportSuccess,
  PurposeOperationIdentity,
  VaultBase,
  VerifiedPersistedOutput,
} from "../../worker/protocol";
import type { DocumentRuntimeResult, ModelSyncRuntimeRequest } from "../../worker/runtime/public";
import { SaveError } from "../save-errors";
import { readExistingFileWithinLimit } from "../bounded-file-read";
import type { PreparedSave } from "../save-existing";
import { inspectTrustedSvgOutput } from "../../scheduling/trusted-svg-output";
import type {
  AutosaveCoordinatorOptions,
  ActiveAutosave,
  AutosaveDelta,
  AutosaveStatus,
  ExternalChangeOutcome,
  FlushOutcome,
  FlushReason,
  FlushWaiter,
} from "./types";
import {
  createExportRequest,
  createModelSyncRequest,
  matchesExportResult,
  matchesModelSyncResult,
  type ConcreteExportRequest,
} from "./export-request";
import { persistPreparedOutput, resolveAutosaveExpectedBase } from "./save-operation";
import { sameVaultBase } from "./verification";
import { createTerminalVaultPort } from "./terminal-vault-port";
import { AutosavePersistedOutputVerifier } from "./persisted-output-verifier";
import { notifyConfirmedPersistence } from "./confirmed-persistence";
import { AutosaveWorkerModelState } from "./worker-model-state";
import { isAutosaveSuspended, terminalAutosaveOutcome } from "./status";
import { ACTIVE_GESTURE_RETRY_MS, AUTOSAVE_DELAY_MS, AutosaveTimer } from "./timer";
import { assertAutosaveInitialState } from "./coordinator-validation";

export class AutosaveCoordinator {
  readonly #beforeExistingWrite;
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
  #modelSyncInFlight: ModelSyncRuntimeRequest | null = null;
  readonly #observer;
  readonly #path;
  #prepared: ExportSuccess | null = null;
  #save: ActiveAutosave | null = null;
  #saveOperationId = 0;
  #savePromise: Promise<void> | null = null;
  readonly #sessionId;
  #status: AutosaveStatus;
  readonly #timer;
  readonly #terminalVault;
  readonly #waiters: FlushWaiter[] = [];
  #workerEpoch;
  readonly #verifier;
  readonly #workerModel;
  public constructor(options: AutosaveCoordinatorOptions) {
    assertAutosaveInitialState(options);
    this.#confirmedContent = options.confirmedContent ?? null;
    this.#beforeExistingWrite = options.beforeExistingWrite;
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
    this.#verifier = new AutosavePersistedOutputVerifier({
      executor: () => this.#executor,
      isDisposed: () => this.#disposed,
      sessionId: this.#sessionId,
      switchToFallback: () => this.#switchToFallback(),
      workerEpoch: () => this.#workerEpoch,
    });
  }
  public get dirty(): boolean {
    return (
      this.#confirmedBase.type === "missing" ||
      this.#confirmedBase.revision !== this.#document.currentRevision()
    );
  }
  public get status(): AutosaveStatus {
    return this.#status;
  }
  public get retainedConfirmedContentBytes(): number {
    return this.#confirmedContent?.length ?? 0;
  }
  public recordCommit(delta: AutosaveDelta): void {
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
        if (this.#forced) this.#kick();
      }
    }
  }
  public recoverWorkerExecutor(): boolean {
    if (this.#disposed || !this.#switchToFallback()) return false;
    this.#prepared = null;
    this.#requireFullSnapshot();
    return true;
  }
  public flush(_reason: FlushReason): Promise<FlushOutcome> {
    if (this.#disposed) return Promise.resolve(terminalAutosaveOutcome(this.dirty, this.#status));
    if (!this.dirty) return Promise.resolve("clean");
    this.#forced = true;
    this.#timer.clear();
    const promise = new Promise<FlushOutcome>((resolve) => this.#waiters.push({ resolve }));
    this.#kick();
    return promise;
  }
  public async retryVerification(): Promise<FlushOutcome> {
    if (this.#disposed) return terminalAutosaveOutcome(this.dirty, this.#status);
    if (this.#status !== "verification-required" || this.#save === null) {
      return terminalAutosaveOutcome(this.dirty, this.#status);
    }
    try {
      await this.#verifyIndeterminateSave();
    } catch {
      this.#setStatus("executor-failed");
    }
    if (this.dirty && !isAutosaveSuspended(this.#status) && this.#forced) this.#kick();
    return terminalAutosaveOutcome(this.dirty, this.#status);
  }
  public async notifyExternalChange(): Promise<ExternalChangeOutcome> {
    if (this.#disposed) return "conflict";
    if (this.dirty) {
      this.#setStatus("conflict");
      this.#resolveWaiters();
      return "conflict";
    }
    const expectedRevision = this.#document.currentRevision();
    let content: string;
    try {
      content = await readExistingFileWithinLimit(this.#terminalVault, this.#path);
    } catch (error) {
      if (this.#disposed) return "conflict";
      throw error;
    }
    if (this.#disposed) return "conflict";
    let persisted: VerifiedPersistedOutput;
    try {
      persisted = await this.#verifier.verify(content, "preflight");
    } catch (error) {
      if (this.#disposed) return "conflict";
      throw error;
    }
    if (this.#disposed) return "conflict";
    if (this.#document.currentRevision() !== expectedRevision || this.dirty) {
      this.#setStatus("conflict");
      this.#resolveWaiters();
      return "conflict";
    }
    if (persisted.type === "unreadable") {
      this.#setStatus("conflict");
      return "conflict";
    }
    this.#confirmedBase = persisted;
    this.#confirmedContent = null;
    return "reload-required";
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
      (result) => this.#adoptExport(request, result),
      () => this.#recoverExecutor(request),
    );
  }
  #adoptExport(request: ConcreteExportRequest, result: DocumentRuntimeResult): void {
    if (this.#disposed || this.#exportInFlight !== request) {
      if (result.type === "export-success") this.#executor.acknowledgeExport?.(result, false);
      return;
    }
    this.#exportInFlight = null;
    if (result.type !== "export-success" || !matchesExportResult(request, result)) {
      if (result.type === "export-success") this.#executor.acknowledgeExport?.(result, false);
      if (result.type === "export-failure" && matchesExportResult(request, result))
        this.#requireFullSnapshot();
      this.#setStatus("retryable-error");
      this.#resolveWaiters();
      return;
    }
    this.#workerModel.acknowledgeExport(result.modelRevision);
    if (result.modelRevision !== this.#document.currentRevision()) {
      this.#executor.acknowledgeExport?.(result, false);
      if (this.#forced) this.#kick();
      return;
    }
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
  async #persist(active: ActiveAutosave): Promise<void> {
    const result = active.result;
    if (result === null) throw new Error("Active save output was already released.");
    let outputTrusted = false;
    try {
      const trusted = await inspectTrustedSvgOutput(result.output, result.outputHash);
      active.result = null;
      if (this.#disposed) return;
      if (trusted.revision !== result.modelRevision)
        throw new TypeError("Export revision mismatch.");
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
        revisionSource: this.#document,
        vault: this.#terminalVault,
        verifier: {
          verify: (content, revision, hash) =>
            this.#verifier.verifyExpected(content, revision, hash),
        },
      });
      if (this.#disposed) return;
      this.#confirmedBase = {
        outputHash: confirmed.outputHash,
        revision: confirmed.revision,
        type: "confirmed",
      };
      this.#confirmedContent = null;
      this.#save = null;
      notifyConfirmedPersistence(this.#observer, this.#path, this.#confirmedBase);
      this.#executor.requestPrewarm?.();
      this.#setStatus(this.dirty ? "debouncing" : "clean");
      this.#resolveWaiters();
    } catch (error) {
      active.result = null;
      if (!this.#disposed) {
        if (outputTrusted) await this.#handleSaveFailure(error);
        else this.#handleUntrustedExport(active);
      }
    } finally {
      this.#savePromise = null;
      if (!this.#disposed && this.dirty && !isAutosaveSuspended(this.#status)) this.#kick();
    }
  }
  #handleUntrustedExport(active: ActiveAutosave): void {
    if (this.#save === active) this.#save = null;
    this.#requireFullSnapshot();
    if (this.#switchToFallback()) this.#setStatus("debouncing");
  }
  async #handleSaveFailure(error: unknown): Promise<void> {
    if (error instanceof SaveError && error.code === "stale-editor-revision") {
      this.#save = null;
      this.#setStatus("debouncing");
      return;
    }
    if (error instanceof SaveError && error.code === "external-conflict") {
      this.#save = null;
      this.#setStatus("conflict");
      this.#resolveWaiters();
      return;
    }
    this.#setStatus("verification-required");
    this.#resolveWaiters();
  }
  async #verifyIndeterminateSave(): Promise<void> {
    if (this.#disposed) return;
    const active = this.#save;
    if (active === null) return;
    let content: string;
    try {
      content = await readExistingFileWithinLimit(this.#terminalVault, this.#path);
    } catch {
      return;
    }
    if (this.#disposed) return;
    const persisted = await this.#verifier.verify(content, "verification");
    if (this.#disposed) return;
    const expected: VaultBase = {
      outputHash: active.proof.outputHash,
      revision: active.proof.revision,
      type: "confirmed",
    };
    if (sameVaultBase(persisted, expected)) {
      this.#confirmedBase = expected;
      this.#confirmedContent = null;
      this.#save = null;
      notifyConfirmedPersistence(this.#observer, this.#path, expected);
      this.#executor.requestPrewarm?.();
      this.#setStatus(this.dirty ? "debouncing" : "clean");
    } else if (sameVaultBase(persisted, active.previousBase)) {
      this.#save = null;
      this.#requireFullSnapshot();
      this.#setStatus("retryable-error");
    } else if (persisted.type !== "unreadable") {
      this.#save = null;
      this.#setStatus("conflict");
    }
    this.#resolveWaiters();
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
  #setStatus(status: AutosaveStatus): void {
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
