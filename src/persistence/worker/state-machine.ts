import {
  CoalescedExportTarget,
  type ExportDelta,
  type ExportMaterialization,
} from "./coalesced-export";
import {
  assertSafeCounter,
  isCurrentExport,
  nextSafeCounter,
  PurposeIdentityRegistry,
} from "./identity";
import type {
  ActiveSaveOperation,
  ActiveSaveProof,
  DocumentRevision,
  ElementId,
  ExportRequest,
  ExportResult,
  PreparedSuccessor,
  PurposeOperationIdentity,
  SaveOperationIdentity,
  SessionId,
  VaultBase,
  VerificationClassification,
  VerificationRecovery,
  VerifiedPersistedOutput,
  WorkerEpoch,
  WorkerPurpose,
} from "./protocol";

export type ExecutorMode = "failed" | "fallback" | "worker";
export type PersistenceStatus = "conflict" | "executor-failed" | "ready" | "verification-required";
export type ExportResultAdmission = "failed" | "prepared" | "stale";
export type WriteAdmission = "base-mismatch" | "started" | "superseded";
export type ExecutorInvalidation =
  "executor-failed" | "fallback-after-write" | "fallback-unwritten";

export interface WorkerStateOptions<TElement> {
  readonly confirmedBase: VaultBase;
  readonly editorRevision: DocumentRevision;
  readonly getElementId: (element: TElement) => ElementId;
  readonly modelRevision: DocumentRevision;
  readonly sessionId: SessionId;
  readonly workerEpoch?: WorkerEpoch;
}

const sameVaultBase = (left: VaultBase, right: VaultBase): boolean => {
  if (left.type === "missing" || right.type === "missing") {
    return left.type === right.type;
  }
  return left.revision === right.revision && left.outputHash === right.outputHash;
};

const proofFrom = (operation: ActiveSaveOperation): ActiveSaveProof =>
  Object.freeze({
    outputHash: operation.outputHash,
    revision: operation.revision,
    saveOperationId: operation.saveOperationId,
  });

export class DocumentWorkerState<TElement, TPage, TSnapshot> {
  readonly #getElementId: (element: TElement) => ElementId;
  readonly #identities: PurposeIdentityRegistry;
  #activeSaveOperation: ActiveSaveOperation | null = null;
  #confirmedBase: VaultBase;
  #editorRevision: DocumentRevision;
  #executorMode: ExecutorMode = "worker";
  #exportInFlight: ExportRequest<TElement, TPage, TSnapshot> | null = null;
  #fallbackUsed = false;
  #modelRevision: DocumentRevision;
  #newestDispatchedExportGeneration = 0;
  #nextSaveOperationId = 0;
  #pendingTarget: CoalescedExportTarget<TElement, TPage> | null = null;
  #persistenceStatus: PersistenceStatus = "ready";
  #preparedSuccessor: PreparedSuccessor | null = null;
  #verificationRecovery: VerificationRecovery | null = null;

  public constructor(options: WorkerStateOptions<TElement>) {
    assertSafeCounter(options.editorRevision, "editorRevision");
    assertSafeCounter(options.modelRevision, "modelRevision");
    if (options.confirmedBase.type === "confirmed") {
      assertSafeCounter(options.confirmedBase.revision, "confirmedBase.revision");
    }
    if (options.modelRevision > options.editorRevision) {
      throw new RangeError("modelRevision cannot exceed editorRevision.");
    }
    this.#getElementId = options.getElementId;
    this.#confirmedBase = options.confirmedBase;
    this.#editorRevision = options.editorRevision;
    this.#modelRevision = options.modelRevision;
    this.#identities = new PurposeIdentityRegistry(options.sessionId, options.workerEpoch);
  }

  public get activeSaveOperation(): ActiveSaveOperation | null {
    return this.#activeSaveOperation;
  }

  public get confirmedBase(): VaultBase {
    return this.#confirmedBase;
  }

  public get dirty(): boolean {
    return (
      this.#confirmedBase.type === "missing" ||
      this.#confirmedBase.revision !== this.#editorRevision
    );
  }

  public get editorRevision(): DocumentRevision {
    return this.#editorRevision;
  }

  public get executorMode(): ExecutorMode {
    return this.#executorMode;
  }

  public get modelRevision(): DocumentRevision {
    return this.#modelRevision;
  }

  public get newestDispatchedExportGeneration(): number {
    return this.#newestDispatchedExportGeneration;
  }

  public get persistenceStatus(): PersistenceStatus {
    return this.#persistenceStatus;
  }

  public get preparedSuccessor(): PreparedSuccessor | null {
    return this.#preparedSuccessor;
  }

  public get verificationRecovery(): VerificationRecovery | null {
    return this.#verificationRecovery;
  }

  public beginOperation(purpose: WorkerPurpose): PurposeOperationIdentity {
    return this.#identities.begin(purpose);
  }

  public acceptsOperation(identity: PurposeOperationIdentity): boolean {
    return this.#identities.isCurrent(identity);
  }

  public finishOperation(identity: PurposeOperationIdentity): boolean {
    return this.#identities.finish(identity);
  }

  public recordCommit(delta: ExportDelta<TElement, TPage>): void {
    assertSafeCounter(delta.modelRevision, "modelRevision");
    if (delta.modelRevision !== this.#editorRevision + 1) {
      throw new RangeError("Each persisted-state commit must increment revision exactly once.");
    }
    this.#editorRevision = delta.modelRevision;
    this.#targetForLaterExport().record(delta);
  }

  public scheduleCurrentRevisionExport(): void {
    this.#targetForLaterExport().record({ modelRevision: this.#editorRevision });
  }

  public invalidateModelBaseline(): void {
    this.#targetForLaterExport().requireFullSnapshot(this.#editorRevision);
  }

  public acknowledgeModelSynchronization(modelRevision: DocumentRevision): void {
    assertSafeCounter(modelRevision, "modelRevision");
    if (modelRevision !== this.#editorRevision) {
      throw new RangeError("Synchronization must acknowledge the current editor revision.");
    }
    this.#modelRevision = modelRevision;
    this.#pendingTarget = new CoalescedExportTarget(modelRevision, this.#getElementId);
    this.#pendingTarget.record({ modelRevision });
  }

  public dispatchExport(
    values: ExportMaterialization<TSnapshot> = {},
  ): ExportRequest<TElement, TPage, TSnapshot> | null {
    if (
      this.#executorMode === "failed" ||
      this.#exportInFlight !== null ||
      this.#pendingTarget === null
    ) {
      return null;
    }
    const plan = this.#pendingTarget.materialize(values);
    const exportGeneration = nextSafeCounter(
      this.#newestDispatchedExportGeneration,
      "exportGeneration",
    );
    const executor = this.#identities.executor;
    const request: ExportRequest<TElement, TPage, TSnapshot> =
      plan.type === "full"
        ? {
            ...executor,
            baseModelRevision: null,
            exportGeneration,
            modelRevision: plan.modelRevision,
            snapshot: plan.snapshot,
            type: "export-full",
          }
        : {
            ...executor,
            baseModelRevision: plan.baseModelRevision,
            changedElements: plan.changedElements,
            exportGeneration,
            modelRevision: plan.modelRevision,
            orderChanges: plan.orderChanges,
            removedIds: plan.removedIds,
            type: "export-incremental",
            ...(plan.page === undefined ? {} : { page: plan.page }),
          };
    this.#newestDispatchedExportGeneration = exportGeneration;
    this.#exportInFlight = request;
    this.#pendingTarget = null;
    return request;
  }

  public acceptExportResult(result: ExportResult): ExportResultAdmission {
    const request = this.#exportInFlight;
    if (!this.#matchesInFlight(request, result)) {
      return "stale";
    }
    this.#exportInFlight = null;
    if (result.type === "export-failure") {
      this.invalidateModelBaseline();
      return "failed";
    }
    this.#modelRevision = result.modelRevision;
    if (result.modelRevision !== this.#editorRevision) {
      return "stale";
    }
    this.#preparedSuccessor = result;
    return "prepared";
  }

  public promotePreparedSuccessor(): ActiveSaveOperation | null {
    const prepared = this.#preparedSuccessor;
    if (
      prepared === null ||
      this.#activeSaveOperation !== null ||
      this.#persistenceStatus !== "ready" ||
      !isCurrentExport(
        this.#identities.executor,
        this.#newestDispatchedExportGeneration,
        prepared,
      ) ||
      prepared.modelRevision !== this.#editorRevision
    ) {
      this.#discardStalePrepared();
      return null;
    }
    this.#nextSaveOperationId = nextSafeCounter(this.#nextSaveOperationId, "saveOperationId");
    this.#activeSaveOperation = {
      output: prepared.output,
      outputHash: prepared.outputHash,
      revision: prepared.modelRevision,
      saveOperationId: this.#nextSaveOperationId,
      sessionId: prepared.sessionId,
      workerEpoch: prepared.workerEpoch,
      writePhase: "preflight",
    };
    this.#preparedSuccessor = null;
    return this.#activeSaveOperation;
  }

  public beginWrite(identity: SaveOperationIdentity, preflightBase: VaultBase): WriteAdmission {
    const active = this.#activeSaveOperation;
    if (!this.#matchesActiveSave(active, identity)) {
      return "superseded";
    }
    if (!sameVaultBase(preflightBase, this.#confirmedBase)) {
      this.#activeSaveOperation = null;
      this.#persistenceStatus = "conflict";
      return "base-mismatch";
    }
    if (active.revision !== this.#editorRevision) {
      this.#activeSaveOperation = null;
      return "superseded";
    }
    this.#activeSaveOperation = { ...active, writePhase: "writing" };
    return "started";
  }

  public beginReadBack(identity: SaveOperationIdentity): boolean {
    const active = this.#activeSaveOperation;
    if (!this.#matchesActiveSave(active, identity) || active.writePhase !== "writing") {
      return false;
    }
    this.#activeSaveOperation = { ...active, writePhase: "read-back" };
    return true;
  }

  public confirmActiveReadBack(
    identity: SaveOperationIdentity,
    persisted: VerifiedPersistedOutput,
  ): VerificationClassification {
    const active = this.#activeSaveOperation;
    if (!this.#matchesActiveSave(active, identity)) {
      return "stale";
    }
    if (persisted.type === "unreadable") {
      return "retry-verification";
    }
    const expected: VaultBase = {
      outputHash: active.outputHash,
      revision: active.revision,
      type: "confirmed",
    };
    this.#activeSaveOperation = null;
    if (!sameVaultBase(expected, persisted)) {
      this.#persistenceStatus = "conflict";
      return "conflict";
    }
    this.#confirmedBase = expected;
    return "confirmed";
  }

  public invalidateExecutor(): ExecutorInvalidation {
    if (this.#fallbackUsed) {
      this.#executorMode = "failed";
      this.#persistenceStatus = "executor-failed";
      return "executor-failed";
    }
    this.#fallbackUsed = true;
    this.#executorMode = "fallback";
    this.#identities.invalidateExecutor();
    this.#exportInFlight = null;
    this.#preparedSuccessor = null;
    this.invalidateModelBaseline();
    const active = this.#activeSaveOperation;
    if (active === null || active.writePhase === "preflight") {
      this.#activeSaveOperation = null;
      return "fallback-unwritten";
    }
    this.#activeSaveOperation = null;
    this.#verificationRecovery = {
      identity: this.#identities.begin("verification"),
      previousBase: this.#confirmedBase,
      proof: proofFrom(active),
    };
    this.#persistenceStatus = "verification-required";
    return "fallback-after-write";
  }

  public classifyRecoveryVerification(
    identity: PurposeOperationIdentity,
    persisted: VerifiedPersistedOutput,
  ): VerificationClassification {
    const recovery = this.#verificationRecovery;
    if (
      recovery === null ||
      identity.purpose !== "verification" ||
      !this.#identities.isCurrent(identity) ||
      recovery.identity.operationId !== identity.operationId
    ) {
      return "stale";
    }
    if (persisted.type === "unreadable") {
      return "retry-verification";
    }
    const writtenBase: VaultBase = {
      outputHash: recovery.proof.outputHash,
      revision: recovery.proof.revision,
      type: "confirmed",
    };
    if (sameVaultBase(persisted, writtenBase)) {
      this.#confirmedBase = writtenBase;
      this.#completeRecovery(identity, "ready");
      return "confirmed";
    }
    if (sameVaultBase(persisted, recovery.previousBase)) {
      this.#completeRecovery(identity, "ready");
      return "retry-write";
    }
    this.#completeRecovery(identity, "conflict");
    return "conflict";
  }

  #completeRecovery(identity: PurposeOperationIdentity, status: PersistenceStatus): void {
    this.#identities.finish(identity);
    this.#verificationRecovery = null;
    this.#persistenceStatus = status;
  }

  #discardStalePrepared(): void {
    const prepared = this.#preparedSuccessor;
    if (
      prepared !== null &&
      (!isCurrentExport(
        this.#identities.executor,
        this.#newestDispatchedExportGeneration,
        prepared,
      ) ||
        prepared.modelRevision !== this.#editorRevision)
    ) {
      this.#preparedSuccessor = null;
    }
  }

  #matchesInFlight(
    request: ExportRequest<TElement, TPage, TSnapshot> | null,
    result: ExportResult,
  ): boolean {
    return (
      request !== null &&
      request.sessionId === result.sessionId &&
      request.workerEpoch === result.workerEpoch &&
      request.exportGeneration === result.exportGeneration &&
      request.modelRevision === result.modelRevision &&
      isCurrentExport(this.#identities.executor, this.#newestDispatchedExportGeneration, result)
    );
  }

  #matchesActiveSave(
    active: ActiveSaveOperation | null,
    identity: SaveOperationIdentity,
  ): active is ActiveSaveOperation {
    return (
      active !== null &&
      active.sessionId === identity.sessionId &&
      active.saveOperationId === identity.saveOperationId
    );
  }

  #targetForLaterExport(): CoalescedExportTarget<TElement, TPage> {
    if (this.#pendingTarget === null) {
      const baseRevision = this.#exportInFlight?.modelRevision ?? this.#modelRevision;
      this.#pendingTarget = new CoalescedExportTarget(baseRevision, this.#getElementId);
    }
    return this.#pendingTarget;
  }
}
