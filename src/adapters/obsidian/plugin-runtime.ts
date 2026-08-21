import { invertedEffects, isolateHistory } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import type { Plugin } from "obsidian";

import type { PrepareHostEffectRequestV1 } from "../../application/host-history/types";
import {
  commandFailure,
  createRandomRelocationIdV1,
  NoteSessionRegistryV1,
  type HostEffectDeliveryV1,
  type HostTransactionSequence,
  type NoteIdentityV1,
  type NoteSessionReferenceV1,
  type NoteSessionV1,
  type ViewId,
} from "../../application/note-session";
import {
  PersistencePermitPool,
  type ExternalConflictChoiceV1,
  type PersistenceCodecPortV1,
  type SidecarStoragePolicyStoreV1,
  type SidecarWritableTierV1,
} from "../../application/persistence";
import type { RecoveryStore } from "../../application/recovery";
import type {
  SourceDigestWorkPortV1,
  SourceMapWorkPortV1,
} from "../../application/source-coordination/work-ports";
import {
  createEditorHistoryBridgeV1,
  type EditorHistoryBridgeCallbacksV1,
  type EditorHistoryBridgeFailureV1,
} from "./editor-history";
import type { RuntimePersistenceV1 } from "./runtime-persistence";
import type { RuntimeExternalChangeVaultV1 } from "./runtime-external-change";
import type { RuntimeSidecarResolutionV1 } from "./runtime-persistence-open";
import {
  createRuntimeSessionV1,
  type RuntimeSessionHistoryV1,
} from "./runtime-session";
import {
  registerObsidianVaultChangesV1,
  registerObsidianVaultRenamesV1,
  type ObsidianVaultChangeV1,
  type ObsidianVaultChangeConsumerV1,
} from "./vault-sidecar/host-events";
import type { SidecarVaultCapability } from "./vault-sidecar/repository";
import type { FrontMatterHostCapability } from "./vault-sidecar/marker";
import { SidecarMarkerWriter } from "./vault-sidecar/marker";
import { RuntimeRelocationControllerV1 } from "./runtime-relocation";
import {
  processRuntimeRenameV1,
  RuntimeRelocationStatusPublisherV1,
} from "./runtime-relocation-gate";
import { createRuntimeMaintenanceControllerV1 } from "./runtime-maintenance";
import type { OrphanSidecarReviewer } from "./vault-sidecar/events";
import {
  VaultSidecarRelocator,
  type SidecarRelocationVaultCapability,
} from "./vault-sidecar/relocation";
import type { VaultFileCapability } from "./vault-sidecar/paths";
import type { ObsidianSidecarTrashPortV1 } from "./vault-sidecar/removal-trash";
import {
  EditorIdentityPool,
  resolveRuntimeEditorIdentityV1,
} from "./editor-note-identity";
export { EditorIdentityPool } from "./editor-note-identity";
export { MAX_ACTIVE_EDITOR_IDENTITIES } from "./editor-note-identity";

type Attachment = ReturnType<EditorHistoryBridgeCallbacksV1["attachEditor"]>;

interface ActiveEditorAttachmentV1 {
  readonly history: RuntimeSessionHistoryV1;
  readonly persistence: RuntimePersistenceV1 | null;
  readonly reference: NoteSessionReferenceV1;
}

export interface EditorNoteIdentityResolverV1 {
  resolve(view: EditorView): NoteIdentityV1 | null;
}

export interface PluginRuntimeOptionsV1 {
  readonly storagePolicy: SidecarStoragePolicyStoreV1;
  readonly recoveryStore: RecoveryStore | null;
  readonly noteIdentityResolver?: EditorNoteIdentityResolverV1;
  readonly persistence?: PluginRuntimePersistenceV1;
  readonly reportHistoryFailure?: (
    failure: EditorHistoryBridgeFailureV1,
  ) => void;
  readonly vaultChangeConsumer?: ObsidianVaultChangeConsumerV1;
  readonly vaultId?: string;
}

export interface PluginRuntimePersistenceV1 {
  readonly disposeOwned: () => void;
  readonly externalVault?: RuntimeExternalChangeVaultV1;
  readonly persistenceCodecPort: PersistenceCodecPortV1;
  readonly orphanReviewer: Pick<OrphanSidecarReviewer, "review">;
  readonly resolveSidecar: (
    identity: NoteIdentityV1,
  ) => RuntimeSidecarResolutionV1;
  readonly relocation: {
    readonly markerHost: FrontMatterHostCapability;
    readonly resolveMarkdownFile: (path: string) => VaultFileCapability | null;
    readonly trash: Pick<ObsidianSidecarTrashPortV1, "trashSidecar">;
    readonly vault: SidecarRelocationVaultCapability;
  };
  readonly sourceDigestWorkPort: SourceDigestWorkPortV1;
  readonly sourceMapWorkPort: SourceMapWorkPortV1;
  readonly vault: SidecarVaultCapability;
  readonly writableTier: SidecarWritableTierV1;
}

export class PluginRuntime {
  readonly #plugin: Plugin;
  readonly #editorIds = new EditorIdentityPool();
  readonly #callbacks: EditorHistoryBridgeCallbacksV1;
  readonly #attachments = new Map<ViewId, ActiveEditorAttachmentV1>();
  readonly #sessionHistory = new WeakMap<
    NoteSessionV1,
    Readonly<{
      history: RuntimeSessionHistoryV1;
      persistence: RuntimePersistenceV1 | null;
    }>
  >();
  readonly #persistenceOwners = new Set<RuntimePersistenceV1>();
  readonly #relocationStatus = new RuntimeRelocationStatusPublisherV1();
  readonly #permits: PersistencePermitPool | null;
  readonly #registry: NoteSessionRegistryV1;
  readonly #relocation: RuntimeRelocationControllerV1 | null;
  public readonly maintenance: ReturnType<
    typeof createRuntimeMaintenanceControllerV1
  >;
  readonly #options: PluginRuntimeOptionsV1;
  #disposePromise: Promise<void> | null = null;
  #vaultEventTail: Promise<void> = Promise.resolve();
  #disposed = false;
  #registered = false;
  #creatingMarkdown: string | null = null;

  public constructor(plugin: Plugin, options: PluginRuntimeOptionsV1) {
    this.#plugin = plugin;
    this.#options = options;
    this.#permits =
      options.persistence === undefined
        ? null
        : new PersistencePermitPool(options.persistence.writableTier);
    this.#registry = new NoteSessionRegistryV1({
      createSession: (identity, capacity): NoteSessionV1 => {
        const persistence = this.#persistenceConfig(identity);
        const composition = createRuntimeSessionV1(
          identity,
          capacity,
          options.recoveryStore,
          options.storagePolicy.snapshot.policy,
          persistence,
        );
        if (composition.persistence !== null) {
          this.#persistenceOwners.add(composition.persistence);
          this.#relocationStatus.register(
            composition.persistence,
            composition.session,
          );
        }
        this.#sessionHistory.set(composition.session, {
          history: composition.history,
          persistence: composition.persistence,
        });
        return composition.session;
      },
      limits: {
        maxQueuedTurns: Number("4096"),
        maxSessions: Number("256"),
        reservedCriticalTurns: Number("512"),
      },
    });
    this.#relocation = this.#createRelocationController();
    this.maintenance = createRuntimeMaintenanceControllerV1(
      options.recoveryStore,
      this.#relocation?.maintenancePorts() ?? null,
      options.storagePolicy,
      options.persistence?.orphanReviewer,
    );
    this.#callbacks = {
      attachEditor: (view): Attachment => this.#attachEditor(view),
      detachEditor: (editorViewId): void => this.#detachEditor(editorViewId),
      enqueueDelivery: (editorViewId, ownerViewId, delivery): void =>
        this.#enqueueDelivery(editorViewId, ownerViewId, delivery),
      enqueueSourceTransition: (editorViewId, transition): void =>
        this.#attachments
          .get(editorViewId)
          ?.persistence?.acceptSourceTransition(editorViewId, transition),
      reportMalformed: (_editorViewId, reason): void =>
        options.reportHistoryFailure?.(reason),
      sequenceHighWater: (
        editorViewId,
        epoch,
      ): HostTransactionSequence | undefined =>
        this.#attachments
          .get(editorViewId)
          ?.history.sequenceHighWater(editorViewId, epoch),
    };
  }

  public get sessionCount(): number {
    return this.#registry.sessionCount;
  }

  public referenceCount(identity: NoteIdentityV1): number {
    return this.#registry.referenceCount(identity);
  }

  public removalFor(
    editorViewId: ViewId,
  ): Pick<RuntimePersistenceV1, "retryRemovalCleanup" | "startRemoval"> | null {
    return this.#attachments.get(editorViewId)?.persistence ?? null;
  }

  public statusFor(editorViewId: ViewId): RuntimePersistenceV1["issueStatus"] {
    return (
      this.#attachments.get(editorViewId)?.persistence?.issueStatus ?? null
    );
  }

  public prepareHostEffect(
    editorViewId: ViewId,
    request: PrepareHostEffectRequestV1,
  ): ReturnType<RuntimePersistenceV1["prepareHostEffect"]> {
    const attachment = this.#attachments.get(editorViewId);
    if (attachment === undefined || request.viewId !== editorViewId) {
      return Promise.resolve({ kind: "rejected" });
    }
    if (
      attachment.persistence !== null &&
      this.#relocation?.isRelocating(attachment.persistence)
    ) {
      return Promise.resolve({ kind: "rejected" });
    }
    return (
      attachment.persistence?.prepareHostEffect(request) ??
      attachment.history.prepareDispatch(request)
    );
  }

  public resolveExternalChange(
    editorViewId: ViewId,
    choice: ExternalConflictChoiceV1,
  ): ReturnType<RuntimePersistenceV1["resolveExternalChange"]> {
    return (
      this.#attachments
        .get(editorViewId)
        ?.persistence?.resolveExternalChange(choice) ??
      Promise.resolve(commandFailure("sidecar-conflict"))
    );
  }

  public whenVaultEventsIdle(): Promise<void> {
    return this.#vaultEventTail;
  }

  public resumeRelocations(): Promise<void> {
    return this.#relocation?.resumeActive() ?? Promise.resolve();
  }

  public register(): void {
    if (this.#registered || this.#disposed) return;
    this.#registered = true;
    const bridge = createEditorHistoryBridgeV1(
      { invertedEffects, isolateHistory },
      this.#callbacks,
    );
    if (bridge.kind === "available") {
      this.#plugin.registerEditorExtension(bridge.extension);
    }
    if (this.#options.vaultChangeConsumer !== undefined) {
      registerObsidianVaultChangesV1(
        this.#plugin,
        this.#options.vaultChangeConsumer,
      );
    } else if (
      this.#options.vaultId !== undefined &&
      this.#options.persistence !== undefined
    ) {
      registerObsidianVaultChangesV1(this.#plugin, {
        accept: (change): void => this.#enqueueVaultChange(change),
      });
    } else if (this.#options.vaultId !== undefined) {
      registerObsidianVaultRenamesV1(this.#plugin, {
        accept: (change): void => this.#enqueueVaultChange(change),
      });
    }
  }

  public dispose(): Promise<void> {
    if (this.#disposePromise !== null) return this.#disposePromise;
    this.#disposed = true;
    for (const editorViewId of [...this.#attachments.keys()]) {
      this.#detachEditor(editorViewId);
    }
    this.#editorIds.dispose();
    this.#disposePromise = this.#vaultEventTail
      .then(() => this.#relocation?.dispose())
      .then(() => this.#registry.dispose(true))
      .then(async () => {
        try {
          this.#options.persistence?.disposeOwned();
        } finally {
          await this.#options.recoveryStore?.dispose();
        }
      })
      .then(() => undefined);
    return this.#disposePromise;
  }

  #attachEditor(view: EditorView): Attachment {
    if (this.#disposed) return null;
    const identity = resolveRuntimeEditorIdentityV1(
      this.#options.noteIdentityResolver,
      view,
    );
    if (identity === null) return null;
    const editorViewId = this.#editorIds.claim();
    if (editorViewId === null) return null;
    this.#creatingMarkdown = view.state.doc.toString();
    const acquired = this.#registry.acquire(identity, editorViewId);
    this.#creatingMarkdown = null;
    if (!acquired.ok) {
      this.#editorIds.release(editorViewId);
      return null;
    }
    const runtime = this.#sessionHistory.get(acquired.value.session);
    if (runtime === undefined) {
      this.#editorIds.release(editorViewId);
      void acquired.value.release({ hostEffectsAreUnreachable: true });
      return null;
    }
    if (runtime.persistence?.attachView(editorViewId) === false) {
      this.#editorIds.release(editorViewId);
      void acquired.value.release({ hostEffectsAreUnreachable: true });
      return null;
    }
    this.#attachments.set(editorViewId, {
      history: runtime.history,
      persistence: runtime.persistence,
      reference: acquired.value,
    });
    void this.#relocation?.resumeActive();
    return { editorViewId, ownerViewId: editorViewId };
  }

  #detachEditor(editorViewId: ViewId): void {
    const attachment = this.#attachments.get(editorViewId);
    if (attachment === undefined) return;
    this.#attachments.delete(editorViewId);
    attachment.persistence?.detachView(editorViewId);
    this.#editorIds.release(editorViewId);
    void attachment.reference.release({ hostEffectsAreUnreachable: true });
  }

  #enqueueDelivery(
    editorViewId: ViewId,
    ownerViewId: ViewId,
    delivery: HostEffectDeliveryV1,
  ): void {
    const attachment = this.#attachments.get(editorViewId);
    if (attachment?.reference.viewId !== ownerViewId) {
      return;
    }
    if (this.#isAttachmentRelocating(attachment)) {
      attachment.history.disposeForReload(true);
      return;
    }
    const queued = attachment.reference.session.enqueue({
      kind: "history",
      retainedBytes: 0,
      run: async ({ publish, snapshot }) => {
        if (this.#isAttachmentRelocating(attachment)) {
          attachment.history.disposeForReload(true);
          return;
        }
        const pending = attachment.history.deliver(
          editorViewId,
          ownerViewId,
          delivery,
        );
        if (pending === null) return;
        const result = await pending;
        if (result.kind !== "accepted") return;
        publish({ ...snapshot, scene: result.scene }, result.affectedIds);
        attachment.persistence?.recordRecoveryAttempt(result.recoveryAttempt);
      },
    });
    void queued.then((result) => {
      if (result.kind !== "completed")
        attachment.history.disposeForReload(true);
    });
  }

  #enqueueVaultChange(change: ObsidianVaultChangeV1): void {
    if (this.#disposed) return;
    const run = async (): Promise<void> => {
      const ownedRelocationId =
        change.kind === "rename"
          ? (this.#relocation?.consumeOwnedSidecarRename(change) ?? null)
          : null;
      const vaultId = this.#options.vaultId;
      if (change.kind === "rename" && vaultId !== undefined) {
        await processRuntimeRenameV1({
          change,
          registry: this.#registry,
          relocation: this.#relocation,
          vaultId,
        });
      }
      for (const owner of this.#persistenceOwners) {
        await owner.acceptVaultChange(change, ownedRelocationId);
      }
    };
    this.#vaultEventTail = this.#vaultEventTail.then(run, run);
  }

  #persistenceConfig(
    identity: NoteIdentityV1,
  ): import("./runtime-session").RuntimeSessionPersistenceConfigV1 | undefined {
    const configured = this.#options.persistence;
    const permits = this.#permits;
    const initialMarkdown = this.#creatingMarkdown;
    if (
      configured === undefined ||
      permits === null ||
      initialMarkdown === null ||
      this.#options.recoveryStore === null
    )
      return undefined;
    let resolution: RuntimeSidecarResolutionV1;
    try {
      resolution = configured.resolveSidecar(identity);
      resolution =
        this.#relocation?.resolveSidecar(
          identity,
          resolution,
          this.#options.storagePolicy.snapshot.policy,
          configured.relocation.resolveMarkdownFile,
        ) ?? resolution;
    } catch {
      resolution = { kind: "blocked" };
    }
    return {
      ...(configured.externalVault === undefined
        ? {}
        : { externalVault: configured.externalVault }),
      initialMarkdown,
      markerHost: configured.relocation.markerHost,
      onDisposed: (owner): void => {
        this.#persistenceOwners.delete(owner);
        this.#relocationStatus.unregister(owner);
      },
      permits,
      readActiveStorageRootRelocation: () =>
        this.#relocation?.activeStorageRootRelocation ?? null,
      readPolicyCreationBlocked: () =>
        this.#options.storagePolicy.state.creationBlocked,
      persistenceCodecPort: configured.persistenceCodecPort,
      recovery: this.#options.recoveryStore,
      removalTrash: configured.relocation.trash,
      resolution,
      resolveMarkdownFile: configured.relocation.resolveMarkdownFile,
      settingsRevision: this.#options.storagePolicy.snapshot.revision,
      sourceDigestWorkPort: configured.sourceDigestWorkPort,
      sourceMapWorkPort: configured.sourceMapWorkPort,
      storagePolicy: this.#options.storagePolicy.snapshot.policy,
      vault: configured.vault,
      writableTier: configured.writableTier,
    };
  }

  #createRelocationController(): RuntimeRelocationControllerV1 | null {
    const persistence = this.#options.persistence;
    const recovery = this.#options.recoveryStore;
    if (persistence === undefined || recovery === null) return null;
    return new RuntimeRelocationControllerV1({
      createRelocationId: createRandomRelocationIdV1,
      marker: new SidecarMarkerWriter(persistence.relocation.markerHost),
      owners: () => [...this.#persistenceOwners],
      publishRelocationState: (owner, relocationId) =>
        this.#relocationStatus.publish(owner, relocationId),
      readSettingsRevision: () => this.#options.storagePolicy.snapshot.revision,
      recovery,
      registry: this.#registry,
      relocator: new VaultSidecarRelocator(persistence.relocation.vault),
      resolveMarkdownFile: persistence.relocation.resolveMarkdownFile,
      storagePolicy: this.#options.storagePolicy,
    });
  }

  #isAttachmentRelocating(attachment: ActiveEditorAttachmentV1): boolean {
    return (
      attachment.persistence !== null &&
      (this.#relocation?.isRelocating(attachment.persistence) ?? false)
    );
  }
}
