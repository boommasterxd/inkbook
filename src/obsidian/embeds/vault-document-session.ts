import type { FileManager } from "obsidian";
import type { InkSnapshotV1 } from "../../domain/schema/public";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { ElementStore } from "../../domain/store/public";
import type * as Session from "../../editor/session/session-port";
import { AutosaveCoordinator } from "../../persistence/saving/autosave/public";
import { prepareAutosaveForUnload } from "../../persistence/saving/autosave/session-coordinator";
import { ensureMigrationBackup } from "../../persistence/documents/migration-backup";
import { validateVaultPath } from "../../persistence/documents/vault-path";
import type { DocumentRuntimePort } from "../../persistence/worker/runtime/public";
import type { DocumentRuntimeFactories, EditableDocumentModel } from "./document-model-port";
import {
  createVaultDocumentExecutor,
  createVaultFallbackFactory,
  readVaultDocumentBytes,
  type LoadedVaultDocument,
  type VaultDocumentFilePort,
} from "./vault-document-loader";
import * as trustedLoader from "./trusted-vault-document-loader";
import * as recovery from "./vault-document-recovery";
import {
  createConfirmedPersistenceObserver,
  createVaultAutosaveSession,
  createVaultClipboardCoordinator,
  createVaultEditableModel,
  createVaultElementPreparationActions,
  prepareVaultElementReplacement,
  requireVaultPage,
} from "./vault-document-model";
import { VaultDocumentSessionMutations } from "./vault-document-session-mutations";
import { lockedDocumentAspectRatio } from "./vault-document-session-identity";
import { loadTrustedDocumentForUnlock } from "./vault-document-trusted-unlock";
import { InteractiveWorkPriority } from "../../editor/session/interactive-work-priority";
import { ActiveEditorHistory } from "./active-editor/history";
export type { DocumentRuntimeFactories, EditableDocumentModel } from "./document-model-port";
export interface ActiveDocumentEditorContext {
  readonly history: ActiveEditorHistory;
  readonly model: EditableDocumentModel;
}
export class VaultDocumentSession implements Session.DocumentSessionPort {
  readonly #cancelled = new Set<number>();
  readonly #identity: Session.SessionIdentity;
  readonly #hooks: recovery.VaultDocumentSessionHooks;
  readonly #loadDocument: ReturnType<typeof trustedLoader.createTrustedVaultDocumentLoader>;
  readonly #workScheduler: WorkScheduler;
  #autosave: AutosaveCoordinator | undefined;
  #confirmedRevision = 0;
  readonly #lifecycle = { disposed: false, preparingForUnload: false };
  #unloadPreparation: Promise<void> | undefined;
  #executor: DocumentRuntimePort | undefined;
  #fallbackUsed = false;
  readonly #workPriority = new InteractiveWorkPriority();
  #history: ActiveEditorHistory | undefined;
  #migrationBackupSourceVersion: number | undefined;
  #model: EditableDocumentModel | undefined;
  #page: InkSnapshotV1["page"] | undefined;
  #pendingTrustedExternalVersion: Session.PersistedDocumentIdentity | undefined;
  #recoveryOperation: Session.RecoveryOperationIdentity | undefined;
  #revision = 0;
  #workerEpoch = 1;
  constructor(
    private readonly fileManager: FileManager,
    private readonly runtimes: DocumentRuntimeFactories,
    private readonly files: VaultDocumentFilePort,
    identity: Session.SessionIdentity,
    private readonly onDispose: () => void,
    hooks: recovery.VaultDocumentSessionHooks = {},
  ) {
    this.#workScheduler = runtimes.workScheduler(identity.documentId);
    this.#identity = identity;
    this.#hooks = hooks;
    this.#loadDocument = trustedLoader.createTrustedVaultDocumentLoader({
      cancelled: (operation) =>
        this.#lifecycle.disposed || this.#cancelled.has(operation.operationId),
      documentId: identity.documentId,
      files,
      scheduler: (isCancelled) => runtimes.createStoreScheduler(identity.documentId, isCancelled),
      hooks,
    });
  }
  get documentModel(): EditableDocumentModel | undefined {
    return this.#lifecycle.preparingForUnload ? undefined : this.#model;
  }
  get editorContext(): ActiveDocumentEditorContext | undefined {
    const history = this.#history;
    const model = this.documentModel;
    return history === undefined || model === undefined ? undefined : { history, model };
  }
  cancelOperation(operation: Session.SessionOperationIdentity): void {
    if (this.#lifecycle.disposed) return;
    this.#cancelled.add(operation.operationId);
  }
  dispose(): void {
    if (this.#lifecycle.disposed) return;
    this.#lifecycle.disposed = true;
    this.#workPriority.dispose();
    this.#autosave?.dispose();
    this.#workScheduler.dispose();
    if (this.#autosave === undefined) this.#executor?.terminate();
    this.#autosave = undefined;
    this.#executor = undefined;
    this.#history?.dispose();
    this.#history = undefined;
    this.#model?.store.releasePreparedPressureGeometry();
    this.#model = undefined;
    this.#page = undefined;
    this.#pendingTrustedExternalVersion = undefined;
    this.#recoveryOperation = undefined;
    this.#cancelled.clear();
    this.onDispose();
  }
  prepareForUnload(): Promise<void> {
    if (this.#unloadPreparation !== undefined) return this.#unloadPreparation;
    if (this.#lifecycle.disposed) return Promise.resolve();
    this.#lifecycle.preparingForUnload = true;
    this.#workPriority.dispose();
    this.#executor?.setLiveInputActive?.(false);
    this.#recoveryOperation = undefined;
    this.#cancelled.clear();
    this.#unloadPreparation = prepareAutosaveForUnload(this.#autosave, () => this.dispose());
    return this.#unloadPreparation;
  }
  async notifyExternalChange(
    operation?: Session.SessionOperationIdentity,
  ): Promise<recovery.SessionExternalChangeOutcome> {
    if (
      this.#lifecycle.disposed ||
      this.#lifecycle.preparingForUnload ||
      this.#autosave === undefined
    )
      return "conflict";
    return recovery.reloadCleanExternalChange({
      accepts: (candidate) =>
        recovery.acceptsSessionOperation(this.#identity, this.#workerEpoch, candidate),
      baseRevision: () => this.#revision,
      notify: () => this.#autosave!.notifyExternalChange(),
      ...(operation === undefined ? {} : { operation }),
      reload: (recovery) => this.#runExternalReload(recovery),
    });
  }
  async #runExternalReload(
    operation: Session.RecoveryOperationIdentity,
  ): Promise<Session.RecoveryResult> {
    this.#recoveryOperation = operation;
    const result = await this.#reloadExternal(operation, false);
    if (this.#recoveryOperation === operation) this.#recoveryOperation = undefined;
    return result;
  }
  getSnapshot(): Session.DocumentSessionSnapshot {
    const autosave = this.#autosave;
    return {
      ...this.#identity,
      confirmedRevision: this.#confirmedRevision,
      dirty: autosave?.dirty ?? false,
      persistencePending:
        autosave !== undefined &&
        (autosave.status === "debouncing" ||
          autosave.status === "saving" ||
          autosave.status === "waiting-for-gesture"),
      revision: this.#revision,
      workerEpoch: this.#workerEpoch,
    };
  }
  async lockLatest(operation: Session.SessionOperationIdentity): Promise<Session.SaveResult> {
    const outcome = await this.#autosave?.flush("lock");
    if (this.#lifecycle.disposed || outcome === undefined || outcome !== "clean") {
      return { ...operation, revision: this.#revision, status: "failed" };
    }
    this.#confirmedRevision = this.#revision;
    return { ...operation, revision: this.#revision, status: "confirmed" };
  }
  async resolveRecovery(
    action: "reload-external" | "save-local-copy",
    operation: Session.RecoveryOperationIdentity,
    completion: recovery.RecoveryCompletionOptions = {},
  ): Promise<Session.RecoveryResult> {
    if (
      this.#lifecycle.disposed ||
      this.#lifecycle.preparingForUnload ||
      !recovery.acceptsRecoveryOperation(
        this.#identity,
        this.#revision,
        this.#workerEpoch,
        operation,
      )
    ) {
      return { ...operation, status: "failed" };
    }
    if (this.#recoveryOperation !== undefined) {
      this.#cancelled.add(this.#recoveryOperation.operationId);
    }
    this.#recoveryOperation = operation;
    const result = await (action === "reload-external"
      ? this.#reloadExternal(operation, true)
      : this.#saveLocalCopy(operation, completion));
    if (this.#recoveryOperation === operation) this.#recoveryOperation = undefined;
    this.#cancelled.delete(operation.operationId);
    return result;
  }
  async unlock(operation: Session.SessionOperationIdentity): Promise<Session.UnlockResult> {
    if (this.#lifecycle.preparingForUnload || this.#model !== undefined)
      return { ...operation, status: "load-error" };
    try {
      const prefetchedBytes = Promise.resolve().then(() =>
        this.#lifecycle.disposed ||
        this.#lifecycle.preparingForUnload ||
        this.#cancelled.has(operation.operationId)
          ? undefined
          : readVaultDocumentBytes(this.files, this.#identity.documentId),
      );
      const executor = await this.#createExecutor();
      if (this.#lifecycle.disposed || this.#cancelled.delete(operation.operationId)) {
        executor.terminate();
        return { ...operation, status: "load-error" };
      }
      let firstRead: Promise<Uint8Array | undefined> | undefined = prefetchedBytes;
      const outcome = await loadTrustedDocumentForUnlock({
        cancelled: () => this.#lifecycle.disposed || this.#cancelled.has(operation.operationId),
        consumeCancellation: () =>
          this.#lifecycle.disposed || this.#cancelled.delete(operation.operationId),
        createFallback: this.#createFallbackFactory(),
        executor,
        fallbackUsed: this.#fallbackUsed,
        load: (candidate, workerEpoch, policy) => {
          const read = firstRead;
          firstRead = undefined;
          return this.#loadDocument(operation, candidate, "unlock", workerEpoch, policy, read);
        },
        operation,
        pendingExternalVersion: this.#pendingTrustedExternalVersion,
        workerEpoch: this.#workerEpoch,
      });
      if (outcome.status === "rejected") {
        this.#pendingTrustedExternalVersion = outcome.pendingExternalVersion;
        if (this.#executor === outcome.executor) this.#executor = undefined;
        return outcome.result;
      }
      this.#pendingTrustedExternalVersion = undefined;
      this.#fallbackUsed = outcome.fallbackUsed;
      this.#executor = outcome.executor;
      this.#workerEpoch = outcome.workerEpoch;
      const loaded = outcome.loaded;
      this.#adoptDocument(
        loaded.snapshot,
        loaded.outputHash,
        loaded.requiresCanonicalRewrite,
        outcome.executor,
        loaded.store,
        loaded.sourceVersion,
      );
      return { ...operation, workerEpoch: this.#workerEpoch, status: "active" };
    } catch {
      this.#executor?.terminate();
      this.#executor = undefined;
      return { ...operation, workerEpoch: this.#workerEpoch, status: "load-error" };
    }
  }
  async #createExecutor(): Promise<DocumentRuntimePort> {
    const created = await createVaultDocumentExecutor({
      disposed: () => this.#lifecycle.disposed,
      documentId: this.#identity.documentId,
      fallbackUsed: this.#fallbackUsed,
      isGestureActive: () => this.#workPriority.inputActive,
      runtimes: this.runtimes,
      sessionId: this.#identity.sessionId,
      workerEpoch: this.#workerEpoch,
    });
    this.#executor = created.executor;
    this.#fallbackUsed = created.fallbackUsed;
    this.#workerEpoch = created.workerEpoch;
    return created.executor;
  }
  #createFallbackFactory(): (workerEpoch: number) => DocumentRuntimePort {
    return createVaultFallbackFactory({
      adopt: (fallback, workerEpoch) => {
        this.#fallbackUsed = true;
        this.#executor = fallback;
        this.#workerEpoch = workerEpoch;
      },
      disposed: () => this.#lifecycle.disposed,
      documentId: this.#identity.documentId,
      isGestureActive: () => this.#workPriority.inputActive,
      runtimes: this.runtimes,
      sessionId: this.#identity.sessionId,
    });
  }
  #adoptDocument(
    snapshot: InkSnapshotV1,
    outputHash: string,
    requiresCanonicalRewrite: boolean,
    executor: DocumentRuntimePort,
    store: ElementStore,
    sourceVersion: number,
  ): void {
    this.#migrationBackupSourceVersion =
      sourceVersion < snapshot.version ? sourceVersion : undefined;
    this.#page = snapshot.page;
    this.#revision = snapshot.revision;
    this.#confirmedRevision = snapshot.revision;
    const clipboard = createVaultClipboardCoordinator({
      autosave: () => this.#autosave,
      disposed: () => this.#lifecycle.disposed,
      executor: () => this.#executor,
      now: () => this.runtimes.now(this.#identity.documentId),
      revision: () => this.#revision,
      sessionId: this.#identity.sessionId,
      workerEpoch: () => this.#workerEpoch,
    });
    const mutations = new VaultDocumentSessionMutations({
      autosave: () => this.#autosave,
      commitState: (committed) => ({ page: this.#page, revision: this.#revision } = committed),
      revision: () => this.#revision,
      setRevision: (revision) => {
        this.#revision = revision;
      },
      store: () => this.#model?.store,
    });
    const scheduler = (cancelled: () => boolean, priority?: "frame") =>
      this.runtimes.createStoreScheduler(
        this.#identity.documentId,
        () => this.#lifecycle.disposed || this.#lifecycle.preparingForUnload || cancelled(),
        priority,
      );
    const model = createVaultEditableModel({
      actions: {
        commitBandOrder: (order) => mutations.commitBandOrder(order),
        commitElement: (element) => mutations.commitElements([element]),
        commitElements: (elements) => mutations.commitElements(elements),
        beginInteractiveOperation: () => this.#workPriority.begin(),
        waitForBackground: () => this.#workPriority.waitForBackground(),
        ...createVaultElementPreparationActions({
          active: () => !this.#lifecycle.disposed && !this.#lifecycle.preparingForUnload,
          run: (operation) => this.#workPriority.run(operation),
          scheduler,
          store,
        }),
        commitPreparedElementMutation: (token) => mutations.commitPreparedElementMutation(token),
        commitPage: (page) => mutations.commitPage(page),
        encodeClipboard: (selectedIds) => clipboard.encode(selectedIds),
        planClipboardPaste: (candidates, invocation, previousRepeat) =>
          clipboard.planPaste(candidates, invocation, previousRepeat),
        arrangeElements: (ids, action) => mutations.arrangeElements(ids, action),
        removeElements: (ids) => mutations.removeElements(ids),
        replaceElements: (elements) => mutations.replaceElements(elements),
        prepareElementReplacement: (replacements, cancellation) =>
          this.#workPriority.run(() =>
            prepareVaultElementReplacement({
              active: this.#autosave !== undefined && !this.#lifecycle.preparingForUnload,
              cancellation,
              replacements,
              scheduler: (isCancelled) => scheduler(isCancelled, "frame"),
              store: this.#model?.store,
            }),
          ),
        commitPreparedElementReplacement: (token) =>
          mutations.commitPreparedElementReplacement(token),
        setGestureActive: (active) => this.#setInputActive(active, "gesture"),
        setNavigationActive: (active) => this.#setInputActive(active, "navigation"),
      },
      state: {
        mutationAvailability: () =>
          this.#revision < Number.MAX_SAFE_INTEGER ? "available" : "revision-exhausted",
        page: () => requireVaultPage(this.#page),
        revision: () => this.#revision,
      },
      store,
    });
    this.#history?.dispose();
    this.#history = new ActiveEditorHistory(model);
    this.#model?.store.releasePreparedPressureGeometry();
    this.#model = model;
    this.#startAutosave(snapshot, outputHash, requiresCanonicalRewrite, executor, store);
  }
  #setInputActive(active: boolean, source: "gesture" | "navigation"): void {
    if (this.#lifecycle.disposed || this.#lifecycle.preparingForUnload) return;
    const previous = this.#workPriority.inputActive;
    this.#workPriority.setInputActive(active, source);
    if (previous !== this.#workPriority.inputActive)
      this.#executor?.setLiveInputActive?.(this.#workPriority.inputActive);
  }
  #startAutosave(
    snapshot: InkSnapshotV1,
    outputHash: string,
    requiresCanonicalRewrite: boolean,
    executor: DocumentRuntimePort,
    store: ElementStore,
  ): void {
    const createFallback = this.#fallbackUsed ? undefined : this.#createFallbackFactory();
    this.#autosave = createVaultAutosaveSession({
      workScheduler: this.#workScheduler,
      waitForBackground: () => this.#workPriority.waitForBackground(),
      beforeExistingWrite: (expectedContent) => this.#preserveMigrationSource(expectedContent),
      clock: this.runtimes.clock(this.#identity.documentId),
      confirmed: createConfirmedPersistenceObserver({
        active: () => !this.#lifecycle.disposed && !this.#lifecycle.preparingForUnload,
        documentId: this.#identity.documentId,
        lockedAspectRatio: () => lockedDocumentAspectRatio(this.#page, store),
        persisted: this.#hooks.persisted,
      }),
      ...(createFallback === undefined ? {} : { createFallback }),
      currentRevision: () => this.#revision,
      executor,
      files: this.files,
      identity: this.#identity,
      initialSnapshot: snapshot,
      isGestureActive: () => this.#workPriority.inputActive,
      outputHash,
      requiresCanonicalRewrite,
      page: () => requireVaultPage(this.#page),
      store,
      workerEpoch: this.#workerEpoch,
    });
  }
  async #preserveMigrationSource(expectedContent: string): Promise<void> {
    const sourceVersion = this.#migrationBackupSourceVersion;
    if (sourceVersion === undefined) return;
    const path = validateVaultPath(this.#identity.documentId);
    if (path === null) throw new Error("migration-backup-invalid-path");
    await ensureMigrationBackup({
      original: expectedContent,
      path,
      port: this.files,
      sourceVersion,
    });
    if (this.#migrationBackupSourceVersion === sourceVersion) {
      this.#migrationBackupSourceVersion = undefined;
    }
  }
  async #reloadExternal(
    operation: Session.RecoveryOperationIdentity,
    acceptExternalVersion: boolean,
  ): Promise<Session.RecoveryResult> {
    const executor = this.#executor;
    if (executor === undefined) return { ...operation, status: "failed" };
    const confirmed = await recovery.reloadExternalDocument({
      adopt: (loaded: LoadedVaultDocument) =>
        this.#adoptDocument(
          loaded.snapshot,
          loaded.outputHash,
          loaded.requiresCanonicalRewrite,
          executor,
          loaded.store,
          loaded.sourceVersion,
        ),
      load: () =>
        this.#loadDocument(operation, executor, "recovery", this.#workerEpoch, {
          ...(acceptExternalVersion ? { acceptExternalVersion: "validated-current" as const } : {}),
        }),
      releaseAutosave: () => {
        this.#autosave?.dispose("preserve-executor");
        this.#autosave = undefined;
      },
      restore: () => {
        const model = this.#model;
        if (this.#lifecycle.disposed || model === undefined) return Promise.resolve();
        return recovery.restoreWorkerBaseline({
          executor,
          identity: this.#identity,
          revision: this.#revision,
          snapshot: model.store.materializeSnapshot({ page: model.page, revision: this.#revision }),
          workerEpoch: this.#workerEpoch,
        });
      },
      stopped: () => this.#recoveryStopped(operation),
    });
    return { ...operation, status: confirmed ? "confirmed" : "failed" };
  }
  async #saveLocalCopy(
    operation: Session.RecoveryOperationIdentity,
    completion: recovery.RecoveryCompletionOptions,
  ): Promise<Session.RecoveryResult> {
    return recovery.saveSessionRecoveryCopy({
      workScheduler: this.#workScheduler,
      completion,
      documentId: this.#identity.documentId,
      executor: this.#executor,
      fileManager: this.fileManager,
      files: this.files,
      operation,
      snapshot: () => {
        const model = this.#model;
        return model?.store.materializeSnapshot({
          page: model.page,
          revision: operation.baseRevision,
        });
      },
      stopped: () => this.#recoveryStopped(operation),
      workerEpoch: this.#workerEpoch,
    });
  }
  #recoveryStopped(operation: Session.RecoveryOperationIdentity): boolean {
    return recovery.recoveryHasStopped(
      this.#lifecycle.disposed,
      this.#recoveryOperation,
      operation,
      this.#revision,
      this.#cancelled,
    );
  }
}
