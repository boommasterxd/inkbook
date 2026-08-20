import {
  commandFailure,
  createSaveGeneration,
} from "../../application/note-session";
import type * as Session from "../../application/note-session";
import type { HostRecordedRecoveryAttemptV1 } from "../../application/host-history";
import type {
  PrepareHostEffectRequestV1,
  PrepareHostEffectResultV1,
} from "../../application/host-history/types";
import * as Persistence from "../../application/persistence";
import type * as Recovery from "../../application/recovery";
import type { EditorSourceTransitionV1 } from "./editor-history/bridge";
import type { ObsidianVaultChangeV1 } from "./vault-sidecar/host-events";
import type { RuntimePersistenceSourceV1 } from "./runtime-persistence-source";
import { RuntimeViewAttachmentsV1 } from "./runtime-source-attachments";
import {
  publishRuntimeSourceReattachmentV1,
  RuntimeSourceEarlyBufferV1,
} from "./runtime-source-early-buffer";
import { bindRuntimePersistenceSourceV1 } from "./runtime-source-binding";
import { openRuntimePersistenceSessionV1 } from "./runtime-persistence-lifecycle";
import { flushRuntimePersistenceV1 } from "./runtime-persistence-flush";
import {
  RuntimePersistenceSaveControllerV1,
  markRuntimePersistenceDirtyV1,
  requireRuntimeSidecarBaseV1,
} from "./runtime-persistence-save";
import {
  VaultSidecarRepository,
  type PreparedSidecarWrite,
} from "./vault-sidecar/repository";
import type { VaultFileCapability } from "./vault-sidecar/paths";
import type { VaultSidecarRelocator } from "./vault-sidecar/relocation";
import { SidecarMarkerWriter } from "./vault-sidecar/marker";
import {
  bindRuntimeFirstSidecarV1,
  type RuntimeFirstSidecarV1,
} from "./runtime-first-sidecar";
import {
  createRuntimeMarkerCorrelationV1,
  prepareRuntimeFirstSidecarV1,
} from "./runtime-persistence-marker";
import { RuntimePersistenceRelocationV1 } from "./runtime-persistence-relocation";
import { runtimePersistenceIssueStatusV1 } from "./runtime-persistence-status";
import {
  createRuntimePersistenceExternalStateV1,
  createRuntimePersistenceExternalV1,
  RuntimeOwnedSidecarWriteV1,
  type RuntimePersistenceIssueStatusV1,
  type RuntimePersistenceExternalV1,
} from "./runtime-persistence-external";
import type { RuntimePersistenceConfigV1 } from "./runtime-session";

export class RuntimePersistenceV1 {
  readonly #config: RuntimePersistenceConfigV1;
  readonly #repository: VaultSidecarRepository;
  readonly #marker: SidecarMarkerWriter;
  readonly #pendingAttempts = new Set<Session.RecoveryAttemptId>();
  readonly #pendingCheckpoints = new Set<Session.SourceCheckpointId>();
  readonly #views = new RuntimeViewAttachmentsV1();
  #base: Recovery.SidecarBaseIdentityV1 | null = null;
  #source: RuntimePersistenceSourceV1 | null = null;
  #disposed = false;
  #file: VaultFileCapability | null = null;
  #flushSave: Promise<Persistence.SavePipelineResultV1> | null = null;
  #flushing = false;
  #layout: Persistence.SidecarStorageLayoutV1 | null = null;
  #nextSave = 0;
  #pipeline: Persistence.SavePipeline<
    Session.NoteSessionSnapshotV1,
    PreparedSidecarWrite
  > | null = null;
  #rawText: string | null = null;
  #session: Session.NoteSessionV1 | null = null;
  #saveScheduler: Persistence.SaveStartScheduler<Session.NoteSessionSnapshotV1> | null =
    null;
  #saveRetryAttempts = 0;
  #saveController: RuntimePersistenceSaveControllerV1;
  readonly #ownedWrite = new RuntimeOwnedSidecarWriteV1();
  readonly #relocation: RuntimePersistenceRelocationV1;
  #identity: Session.NoteIdentityV1;
  #firstSidecar: RuntimeFirstSidecarV1<
    Extract<PrepareHostEffectResultV1, { readonly kind: "prepared" }>
  > | null = null;
  #external: RuntimePersistenceExternalV1 | null = null;
  #pendingRemoval: Recovery.ActiveRemovalRecoveryV1 | null = null;
  readonly #earlySource = new RuntimeSourceEarlyBufferV1(() =>
    publishRuntimeSourceReattachmentV1(this.#session, this.#source),
  );

  public constructor(config: RuntimePersistenceConfigV1) {
    this.#config = config;
    this.#identity = config.identity;
    this.#repository = new VaultSidecarRepository(config.vault);
    this.#marker = new SidecarMarkerWriter(config.markerHost);
    this.#saveController = new RuntimePersistenceSaveControllerV1({
      config,
      onAcknowledged: (replacement, rawText, generation, digest): void => {
        this.#saveRetryAttempts = 0;
        this.#base = replacement;
        this.#rawText = rawText;
        this.#config.history.updatePersistenceContext(
          replacement,
          generation,
          digest,
        );
      },
      onWritePrepared: (replacement): void =>
        this.#ownedWrite.prepare(replacement),
      onWriteRejected: (replacement): void =>
        this.#ownedWrite.reject(replacement),
      readFile: (): VaultFileCapability | null => this.#file,
      readFlushing: (): boolean => this.#flushing,
      readRawText: (): string | null => this.#rawText,
      readSession: (): Session.NoteSessionV1 | null => this.#session,
      repository: this.#repository,
      retainForRetry: (failedRequest): void => {
        if (this.#saveScheduler?.retainForRetry(failedRequest) === true)
          this.#saveRetryAttempts += 1;
      },
      setFlushSave: (save): void => {
        this.#flushSave = save;
      },
    });
    this.#relocation = new RuntimePersistenceRelocationV1({
      createSavePipeline: (): void => this.#createSavePipeline(),
      flush: (): Promise<"failed" | "flushed"> => this.flush(),
      history: config.history,
      markDirty: (): void => this.#markDirty(),
      normalizePath: config.vault.normalizePath,
      readBase: (): Recovery.SidecarBaseIdentityV1 | null => this.#base,
      readFile: (): VaultFileCapability | null => this.#file,
      readIdentity: (): Session.NoteIdentityV1 => this.#identity,
      readLayout: (): Persistence.SidecarStorageLayoutV1 | null => this.#layout,
      readPipelineAvailable: (): boolean => this.#pipeline !== null,
      readSession: (): Session.NoteSessionV1 | null => this.#session,
      readSource: (): RuntimePersistenceSourceV1 | null => this.#source,
      setBase: (base: Recovery.SidecarBaseIdentityV1): void => {
        this.#base = base;
      },
      setFile: (file: VaultFileCapability): void => {
        this.#file = file;
      },
      setIdentity: (identity: Session.NoteIdentityV1): void => {
        this.#identity = identity;
      },
    });
  }

  public bind(session: Session.NoteSessionV1): void {
    if (this.#session !== null || this.#disposed) return;
    this.#session = session;
    this.#firstSidecar = bindRuntimeFirstSidecarV1({
      awaitObservedMarkerCheckpoint: (signal, correlation) =>
        this.#source?.awaitObservedMarkerCheckpoint(signal, correlation) ??
        Promise.resolve(null),
      config: this.#config,
      marker: this.#marker,
      readBase: () => requireRuntimeSidecarBaseV1(this.#base),
      readIdentity: () => this.#identity,
      readRelocationGate: () => ({
        activeStorageRootRelocation:
          this.#config.readActiveStorageRootRelocation(),
        policyCreationBlocked: this.#config.readPolicyCreationBlocked(),
      }),
      repository: this.#repository,
      session,
    });
    this.#external = createRuntimePersistenceExternalV1({
      config: this.#config,
      consumeOwnedWrite: (base): boolean => this.#ownedWrite.consume(base),
      history: this.#config.history,
      marker: this.#marker,
      onRemoved: (base): void => {
        this.#saveScheduler?.dispose();
        void this.#pipeline?.dispose();
        this.#base = base;
        this.#file = null;
        this.#layout = null;
        this.#pendingAttempts.clear();
        this.#pendingCheckpoints.clear();
        this.#pendingRemoval = null;
        this.#pipeline = null;
        this.#rawText = null;
        this.#saveScheduler = null;
      },
      onReload: (reload): void => {
        this.#base = reload.base;
        this.#file = reload.file;
        this.#layout = reload.sidecar.storageLayout;
        this.#rawText = reload.rawText;
        this.#pendingAttempts.clear();
        this.#pendingCheckpoints.clear();
        this.#createSavePipeline();
      },
      readState: () =>
        createRuntimePersistenceExternalStateV1({
          activeRelocation: this.#relocation.active,
          base: this.#base?.revision === null ? null : this.#base,
          identity: this.#identity,
          pendingRecovery:
            this.#pendingAttempts.size > 0 || this.#pendingCheckpoints.size > 0,
          rawText: this.#rawText,
          source: this.#source?.durableSource,
          sourceUtf16Length: this.#source?.durableUtf16Length ?? 0,
        }),
      session,
    });
    void session.enqueue({
      kind: "lifecycle",
      retainedBytes: this.#config.initialMarkdown.length * Number("2"),
      run: async ({ publish, snapshot }) => {
        const opened = await this.#open(snapshot);
        publish(opened);
        const removal = this.#pendingRemoval;
        if (removal !== null) this.#external?.resumeRemoval(removal);
      },
    });
  }

  public attachView(viewId: Session.ViewId): void {
    if (!this.#disposed) this.#views.attach(viewId);
  }

  public get issueStatus(): RuntimePersistenceIssueStatusV1 | null {
    return runtimePersistenceIssueStatusV1(
      this.#external?.issueStatus,
      this.#saveRetryAttempts,
    );
  }

  public detachView(viewId: Session.ViewId): void {
    this.#views.detach(viewId);
  }

  public acceptSourceTransition(
    viewId: Session.ViewId,
    transition: EditorSourceTransitionV1,
  ): void {
    if (this.#disposed) return;
    this.#earlySource.accept(viewId, transition, this.#source);
  }

  public recordRecoveryAttempt(attempt: HostRecordedRecoveryAttemptV1): void {
    if (
      attempt.kind === "host-recorded-forward" &&
      this.#session?.snapshot.persistence.kind === "first-sidecar-pending" &&
      this.#firstSidecar !== null
    ) {
      void this.#firstSidecar.recordHostForward(attempt).then((result) => {
        if (result.kind === "acknowledged") void this.#adoptFirstSidecar();
      });
      return;
    }
    if (this.#pipeline === null || this.#disposed) return;
    this.#pendingAttempts.add(attempt.attemptId);
    this.#markDirty();
  }

  public prepareHostEffect(
    request: PrepareHostEffectRequestV1,
  ):
    | Promise<
        Persistence.FirstSidecarPrepareResultV1<
          Extract<PrepareHostEffectResultV1, { readonly kind: "prepared" }>
        >
      >
    | ReturnType<RuntimePersistenceConfigV1["history"]["prepareDispatch"]> {
    const persistence = this.#session?.snapshot.persistence.kind;
    if (
      persistence === "conflict" ||
      persistence === "drift" ||
      this.#external?.mutationBlocked === true
    )
      return Promise.resolve({ kind: "rejected" });
    return this.#session?.snapshot.persistence.kind === "unannotated" &&
      this.#firstSidecar !== null
      ? prepareRuntimeFirstSidecarV1({
          correlation: createRuntimeMarkerCorrelationV1({
            base: this.#base,
            identity: this.#identity,
            normalizePath: this.#config.vault.normalizePath,
            request,
            settingsRevision: this.#config.settingsRevision,
            source: this.#session.snapshot.source,
            storagePolicy: this.#config.storagePolicy,
          }),
          firstSidecar: this.#firstSidecar,
          request,
          source: this.#source,
        })
      : this.#config.history.prepareDispatch(request);
  }

  public async acceptVaultChange(
    change: ObsidianVaultChangeV1,
    ownedRelocationId: Session.RelocationId | null = null,
  ): Promise<void> {
    if (!this.#disposed)
      await this.#external?.accept(change, ownedRelocationId);
  }

  public resolveExternalChange(
    choice: Persistence.ExternalConflictChoiceV1,
  ): Promise<Session.CommandResultV1<void>> {
    return (
      this.#external?.resolve(choice) ??
      Promise.resolve(commandFailure("sidecar-conflict"))
    );
  }

  public retrySave(): boolean {
    const started = this.#saveScheduler?.retry() ?? false;
    if (started) this.#saveRetryAttempts = 0;
    return started;
  }

  public retryRemovalCleanup(): Promise<Session.CommandResultV1<void>> {
    return (
      this.#external?.retryRemovalCleanup() ??
      Promise.resolve(commandFailure("read-only-mode"))
    );
  }

  public startRemoval(
    record: import("../../application/recovery").RemovalRecordV1,
  ): Promise<Session.CommandResultV1<void>> {
    return (
      this.#external?.startRemoval(record) ??
      Promise.resolve(commandFailure("read-only-mode"))
    );
  }

  public async flush(): Promise<"failed" | "flushed"> {
    return flushRuntimePersistenceV1({
      forceSave: (): void => {
        this.#saveScheduler?.forceFlush();
      },
      forceSource: (): Promise<boolean> =>
        this.#source?.force() ?? Promise.resolve(true),
      readSave: () => this.#flushSave,
      session: this.#session,
      setFlushing: (flushing): void => {
        this.#flushing = flushing;
      },
    });
  }

  public relocationMember(
    replacement: Session.NoteIdentityV1,
    ordinal: number,
    layout: Persistence.SidecarStorageLayoutV1 | null = this.#layout,
  ): Recovery.PrefixRelocationMemberV1 | null {
    return this.#disposed
      ? null
      : this.#relocation.member(replacement, ordinal, layout);
  }

  public async settleAndMoveSidecar(
    record: Recovery.FileRelocationRecordV1,
    relocator: VaultSidecarRelocator,
  ): Promise<Session.CommandResultV1<void>> {
    return this.#relocation.settleAndMove(record, relocator);
  }

  public setActiveRelocation(
    record: Recovery.FileRelocationRecordV1 | null,
  ): void {
    this.#relocation.setActive(record);
  }

  public rekeyPersistence(record: Recovery.FileRelocationRecordV1): void {
    this.#relocation.rekey(record);
  }

  public async saveRelocatedMetadata(): Promise<Session.CommandResultV1<void>> {
    return this.#relocation.saveMetadata();
  }

  public async awaitRelocationCheckpoint(): Promise<
    Session.CommandResultV1<void>
  > {
    return this.#relocation.awaitCheckpoint();
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#saveScheduler?.dispose();
    await this.#firstSidecar?.dispose();
    await this.#pipeline?.dispose();
    await this.#external?.dispose();
    this.#views.dispose();
    this.#earlySource.dispose();
    this.#source?.dispose();
    this.#marker.dispose();
    this.#repository.dispose();
    this.#config.onDisposed?.(this);
  }

  async #open(
    snapshot: Session.NoteSessionSnapshotV1,
  ): Promise<Session.NoteSessionSnapshotV1> {
    return openRuntimePersistenceSessionV1({
      config: this.#config,
      marker: this.#marker,
      repository: this.#repository,
      snapshot,
      state: {
        addAttempt: (attemptId): void => {
          this.#pendingAttempts.add(attemptId);
        },
        addCheckpoint: (checkpointId): void => {
          this.#pendingCheckpoints.add(checkpointId);
        },
        createSource: (opened): Promise<void> =>
          this.#createSource(opened.base, opened.generation, opened.digest),
        createSavePipeline: (): void => this.#createSavePipeline(),
        hasSource: (): boolean => this.#source !== null,
        initializeHistory: (opened): boolean =>
          this.#config.history.initialize(
            opened.kind === "existing" ? opened.scene : snapshot.scene,
            {
              base: opened.base,
              sourceDigest: opened.digest,
              sourceGeneration: opened.generation,
              ...(opened.kind === "existing"
                ? { restoreSnapshot: opened.historySnapshot }
                : {}),
            },
          ),
        markDirty: (): void => this.#markDirty(),
        setBase: (base): void => {
          this.#base = base;
        },
        setFile: (file): void => {
          this.#file = file;
        },
        setLayout: (layout): void => {
          this.#layout = layout;
        },
        setPendingRemoval: (removal): void => {
          this.#pendingRemoval = removal;
        },
        setRawText: (rawText): void => {
          this.#rawText = rawText;
        },
      },
    });
  }

  async #createSource(
    base: Recovery.SidecarBaseIdentityV1,
    generation: Session.SourceGeneration,
    digest: Session.Sha256Digest,
  ): Promise<void> {
    this.#base = base;
    const session = this.#session;
    if (session === null) return;
    this.#source = await bindRuntimePersistenceSourceV1({
      config: this.#config,
      bindViews: (source): void => this.#views.bind(source),
      drainEarly: (source): void => this.#earlySource.drain(source),
      onDurable: (checkpoint) => {
        this.#pendingCheckpoints.add(checkpoint.checkpointId);
        this.#config.history.updatePersistenceContext(
          base,
          checkpoint.replacementGeneration,
          checkpoint.replacementDigest,
        );
        this.#markDirty();
      },
      session,
      digest,
      generation,
      readBase: () => {
        if (this.#base === null) throw new Error("Sidecar base unavailable.");
        return this.#base;
      },
    });
  }

  #createSavePipeline(): void {
    const base = this.#base;
    const layout = this.#layout;
    if (base === null || layout === null) return;
    this.#saveScheduler?.dispose();
    void this.#pipeline?.dispose();
    const binding = this.#saveController.bind(base, this.#identity, layout);
    this.#pipeline = binding.pipeline;
    this.#saveScheduler = binding.scheduler;
  }

  async #adoptFirstSidecar(): Promise<void> {
    const adopted = await this.#firstSidecar?.loadCreated();
    if (adopted === null || adopted === undefined) return;
    this.#file = adopted.file;
    this.#layout = adopted.layout;
    this.#rawText = adopted.rawText;
    this.#base = adopted.base;
    this.#ownedWrite.prepare(adopted.base);
    this.#createSavePipeline();
  }

  #markDirty(): void {
    const session = this.#session;
    const source = this.#source;
    const scheduler = this.#saveScheduler;
    if (session === null || source === null || scheduler === null) return;
    markRuntimePersistenceDirtyV1({
      createGeneration: (): ReturnType<typeof createSaveGeneration> =>
        createSaveGeneration(++this.#nextSave),
      pendingAttempts: this.#pendingAttempts,
      pendingCheckpoints: this.#pendingCheckpoints,
      scheduler,
      session,
      source: source.durableSource,
      onScheduled: (): void => {
        this.#saveRetryAttempts = 0;
      },
    });
  }
}
