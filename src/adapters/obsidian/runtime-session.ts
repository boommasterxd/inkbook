import { createSceneRevision } from "../../domain/model";
import { createRuntimeSceneStateV1 } from "../../domain/scene";
import {
  HostHistoryCoordinatorV1,
  type HostHistorySnapshotV1,
} from "../../application/host-history";
import type {
  PrepareHostEffectRequestV1,
  PrepareHostEffectResultV1,
} from "../../application/host-history/types";
import type { HostEffectDeliveryResultV1 } from "../../application/host-history/types";
import {
  createSessionOrder,
  createSourceGeneration,
  NoteSessionQueueV1,
  type NoteSessionQueueCapacityV1,
  type NoteSessionHistoryAuthorityV1,
  type NoteSessionHistoryRekeyReservationV1,
  type NoteSessionSnapshotV1,
  NoteSessionV1,
  parseSha256Digest,
  type HostEffectDeliveryV1,
  type HostTransactionSequence,
  type NoteIdentityV1,
  type RecoveryAttemptId,
  type SessionOrder,
  type Sha256Digest,
  type SourceGeneration,
  type ViewId,
} from "../../application/note-session";
import type {
  PrefixRelocationRecordV1,
  RecoveryStore,
} from "../../application/recovery";
import {
  resolveNewSidecarPathV1,
  type PersistenceCodecPortV1,
  type PersistencePermitPool,
  type SidecarWritableTierV1,
  type SidecarStoragePolicyV1,
  type FirstSidecarDispatchPreparationV1,
} from "../../application/persistence";
import type {
  SourceDigestWorkPortV1,
  SourceMapWorkPortV1,
} from "../../application/source-coordination/work-ports";
import { SOURCE_COORDINATION_LIMITS_V1 } from "../../application/source-coordination";
import { RuntimePersistenceV1 } from "./runtime-persistence";
import { RuntimeHistoryMaterializationV1 } from "./runtime-history-materialization";
import {
  createRuntimeHistoryCoordinatorV1,
  type RuntimeHistoryRecoveryIdentityV1,
} from "./runtime-history-coordinator";
import type { SourceMapGraphNodeV1 } from "../../application/source-coordination";
import type { RuntimeSidecarResolutionV1 } from "./runtime-persistence-open";
import type { FrontMatterHostCapability } from "./vault-sidecar/marker";
import type { VaultFileCapability } from "./vault-sidecar/paths";
import type { ObsidianSidecarTrashPortV1 } from "./vault-sidecar/removal-trash";
import type { SidecarVaultCapability } from "./vault-sidecar/repository";
import type { RuntimeExternalChangeVaultV1 } from "./runtime-external-change";

const EMPTY_SHA256 = parseSha256Digest(
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
);
const SESSION_QUEUE_TURNS = 64;
const SESSION_QUEUE_BYTES =
  SOURCE_COORDINATION_LIMITS_V1.maxMarkdownUtf16Length * Number("2");
const SESSION_RESERVED_TURNS = 8;
const SESSION_RESERVED_BYTES = 262_144;

export class RuntimeSessionHistoryV1 implements NoteSessionHistoryAuthorityV1 {
  #coordinator: HostHistoryCoordinatorV1 | null = null;
  readonly #recovery: RecoveryStore | null;
  readonly #nextSessionOrder: () => SessionOrder;
  readonly #storagePolicy: SidecarStoragePolicyV1;
  #recoveryContext: RuntimeRecoveryIdentityV1 | null = null;
  #identity: NoteIdentityV1;
  #preparedAttemptId: RecoveryAttemptId | null = null;
  readonly #materialization = new RuntimeHistoryMaterializationV1();

  public constructor(
    identity: NoteIdentityV1,
    recovery: RecoveryStore | null,
    storagePolicy: SidecarStoragePolicyV1,
    nextSessionOrder: () => SessionOrder,
  ) {
    this.#identity = Object.freeze({ ...identity });
    this.#recovery = recovery;
    this.#nextSessionOrder = nextSessionOrder;
    this.#storagePolicy = storagePolicy;
  }

  public initialize(
    scene: NoteSessionSnapshotV1["scene"],
    context: RuntimeHistoryContextV1,
  ): boolean {
    if (this.#recovery === null || this.#coordinator !== null) return false;
    this.#recoveryContext = Object.freeze({
      base: Object.freeze({ ...context.base }),
      identity: this.#identity,
      sourceDigest: context.sourceDigest,
      sourceGeneration: context.sourceGeneration,
    });
    this.#coordinator = createRuntimeHistoryCoordinatorV1({
      identity: this.#identity,
      initialScene: scene,
      nextSessionOrder: this.#nextSessionOrder,
      onPreparedAttempt: (attemptId): void => {
        this.#preparedAttemptId = attemptId;
      },
      onRelease: (entry): void => this.#materialization.release(entry),
      readIdentity: () => this.#recoveryIdentity(),
      recovery: this.#recovery,
      ...(context.restoreSnapshot === undefined
        ? {}
        : { restoreSnapshot: context.restoreSnapshot }),
    });
    this.#installMaterialization(context.restoreSnapshot?.entries ?? []);
    return true;
  }

  public updatePersistenceContext(
    base: RuntimeHistoryContextV1["base"],
    generation: SourceGeneration,
    digest: Sha256Digest,
  ): void {
    if (this.#recoveryContext === null) return;
    this.#recoveryContext = Object.freeze({
      base: Object.freeze({ ...base }),
      identity: this.#identity,
      sourceDigest: digest,
      sourceGeneration: generation,
    });
  }

  public replaceAfterExternalReload(
    scene: NoteSessionSnapshotV1["scene"],
    context: RuntimeHistoryContextV1,
  ): boolean {
    const prior = this.#coordinator;
    const recovery = this.#recovery;
    if (prior === null || recovery === null) return false;
    const replacementContext = Object.freeze({
      base: Object.freeze({ ...context.base }),
      identity: this.#identity,
      sourceDigest: context.sourceDigest,
      sourceGeneration: context.sourceGeneration,
    });
    let replacement: HostHistoryCoordinatorV1;
    try {
      replacement = createRuntimeHistoryCoordinatorV1({
        identity: this.#identity,
        initialScene: scene,
        nextSessionOrder: this.#nextSessionOrder,
        onRelease: (entry): void => this.#materialization.release(entry),
        readIdentity: () => replacementContext,
        recovery,
        ...(context.restoreSnapshot === undefined
          ? {}
          : { restoreSnapshot: context.restoreSnapshot }),
      });
    } catch {
      return false;
    }
    this.#recoveryContext = replacementContext;
    this.#coordinator = replacement;
    this.#preparedAttemptId = null;
    this.#installMaterialization(context.restoreSnapshot?.entries ?? []);
    prior.disposeForReload(true);
    return true;
  }

  public currentLease(): NoteSessionSnapshotV1["historyLease"] {
    const lease = this.#coordinator?.lease;
    if (lease === undefined) {
      return Object.freeze({ kind: "blocked", reason: "recovery-unavailable" });
    }
    if (lease.kind !== "blocked") return lease;
    return Object.freeze({ kind: "blocked", reason: "history-unavailable" });
  }

  public closeOwner(viewId: ViewId, effectsAreUnreachable: boolean): boolean {
    return (
      this.#coordinator?.closeOwner(viewId, effectsAreUnreachable) ?? false
    );
  }

  public disposeForReload(hostEffectsMayBeReachable: boolean): void {
    this.#coordinator?.disposeForReload(hostEffectsMayBeReachable);
    this.#materialization.dispose();
  }

  public prepareNoteIdentityRekey(
    priorIdentity: NoteIdentityV1,
    replacementIdentity: NoteIdentityV1,
  ): NoteSessionHistoryRekeyReservationV1 | null {
    if (!sameIdentity(this.#identity, priorIdentity)) return null;
    let replacementSidecarPath: string;
    try {
      replacementSidecarPath = this.#resolveSidecarPath(replacementIdentity);
    } catch {
      return null;
    }
    const priorContext = this.#recoveryContext;
    let committed = false;
    return Object.freeze({
      commit: (): void => {
        if (committed) return;
        if (
          this.#coordinator !== null &&
          !this.#coordinator.rekeyNoteIdentity(
            priorIdentity,
            replacementIdentity,
          )
        ) {
          throw new Error("Host history rejected the identity rekey.");
        }
        committed = true;
        this.#applyIdentity(replacementIdentity, replacementSidecarPath);
      },
      rollback: (): void => {
        if (!committed) return;
        if (
          this.#coordinator !== null &&
          !this.#coordinator.rekeyNoteIdentity(
            replacementIdentity,
            priorIdentity,
          )
        ) {
          throw new Error("Host history rejected the identity rollback.");
        }
        committed = false;
        this.#identity = Object.freeze({ ...priorIdentity });
        this.#recoveryContext = priorContext;
      },
    });
  }

  public deliver(
    editorViewId: ViewId,
    ownerViewId: ViewId,
    delivery: HostEffectDeliveryV1,
  ): Promise<HostEffectDeliveryResultV1> | null {
    return (
      this.#coordinator?.deliverInSessionTurn(
        editorViewId,
        ownerViewId,
        delivery,
      ) ?? null
    );
  }

  public bindSourceMaterialization(
    readCurrentSource: () => SourceMapGraphNodeV1,
  ): void {
    this.#materialization.bind(readCurrentSource);
    this.#coordinator?.setHistoryMaterialization(this.#materialization);
  }

  public async prepareDispatch(
    request: PrepareHostEffectRequestV1,
  ): Promise<
    FirstSidecarDispatchPreparationV1<
      Extract<PrepareHostEffectResultV1, { readonly kind: "prepared" }>
    >
  > {
    this.#preparedAttemptId = null;
    const source = this.#materialization.currentSource;
    const prepared = await this.#coordinator?.prepare(request);
    const attemptId = this.#takePreparedAttemptId();
    if (prepared?.kind === "prepared" && attemptId !== null) {
      if (source !== null) {
        this.#materialization.associateIdentity(
          prepared.envelope.effectId,
          source,
        );
      }
      return Object.freeze({
        dispatch: prepared,
        kind: "prepared",
        recoveryAttemptId: attemptId,
      });
    }
    return Object.freeze({ kind: "rejected" });
  }

  public sequenceHighWater(
    editorViewId: ViewId,
    historyEpoch: import("../../application/host-history").HistoryEpoch,
  ): HostTransactionSequence | undefined {
    return this.#coordinator?.sequenceHighWater(editorViewId, historyEpoch);
  }

  #takePreparedAttemptId(): RecoveryAttemptId | null {
    return this.#preparedAttemptId;
  }

  #resolveSidecarPath(identity: NoteIdentityV1): string {
    return resolveNewSidecarPathV1(
      this.#storagePolicy,
      identity.vaultRelativeMarkdownPath,
    );
  }

  #applyIdentity(identity: NoteIdentityV1, sidecarPath: string): void {
    this.#identity = Object.freeze({ ...identity });
    if (this.#recoveryContext === null) return;
    const base = this.#recoveryContext.base;
    this.#recoveryContext = Object.freeze({
      ...this.#recoveryContext,
      base: Object.freeze({
        ...base,
        markdownPath: identity.vaultRelativeMarkdownPath,
        vaultRelativePath:
          base.revision === null ? sidecarPath : base.vaultRelativePath,
      }),
      identity: this.#identity,
    });
  }

  #recoveryIdentity(): RuntimeRecoveryIdentityV1 {
    if (this.#recoveryContext === null) {
      throw new Error("The runtime recovery context is unavailable.");
    }
    return this.#recoveryContext;
  }

  #installMaterialization(
    entries: readonly import("../../application/host-history").ActionableHistoryEntrySnapshotV1[],
  ): void {
    const source = this.#materialization.currentSource;
    this.#materialization.reset(entries, source);
    if (source !== null) {
      this.#coordinator?.setHistoryMaterialization(this.#materialization);
    }
  }
}

type RuntimeRecoveryIdentityV1 = RuntimeHistoryRecoveryIdentityV1;

interface RuntimeHistoryContextV1 {
  readonly base: import("../../application/recovery").SidecarBaseIdentityV1;
  readonly sourceDigest: Sha256Digest;
  readonly sourceGeneration: SourceGeneration;
  readonly restoreSnapshot?: HostHistorySnapshotV1;
}

export interface RuntimePersistenceConfigV1 {
  readonly history: import("./runtime-persistence-external").RuntimePersistenceHistoryV1;
  readonly identity: NoteIdentityV1;
  readonly initialMarkdown: string;
  readonly externalVault?: RuntimeExternalChangeVaultV1;
  readonly markerHost: FrontMatterHostCapability;
  readonly nextSessionOrder: () => SessionOrder;
  readonly onDisposed?: (owner: RuntimePersistenceV1) => void;
  readonly permits: PersistencePermitPool;
  readonly persistenceCodecPort: PersistenceCodecPortV1;
  readonly readActiveStorageRootRelocation: () => PrefixRelocationRecordV1 | null;
  readonly readPolicyCreationBlocked: () => boolean;
  readonly recovery: RecoveryStore;
  readonly removalTrash?: Pick<ObsidianSidecarTrashPortV1, "trashSidecar">;
  readonly resolution: RuntimeSidecarResolutionV1;
  readonly resolveMarkdownFile: (path: string) => VaultFileCapability | null;
  readonly settingsRevision: import("../../application/note-session").SettingsRevision;
  readonly sourceDigestWorkPort: SourceDigestWorkPortV1;
  readonly sourceMapWorkPort: SourceMapWorkPortV1;
  readonly storagePolicy: SidecarStoragePolicyV1;
  readonly vault: SidecarVaultCapability;
  readonly writableTier: SidecarWritableTierV1;
}

export interface RuntimeSessionCompositionV1 {
  readonly history: RuntimeSessionHistoryV1;
  readonly persistence: RuntimePersistenceV1 | null;
  readonly session: NoteSessionV1;
}

export type RuntimeSessionPersistenceConfigV1 = Omit<
  RuntimePersistenceConfigV1,
  "history" | "identity" | "nextSessionOrder"
>;

export function createRuntimeSessionV1(
  identity: NoteIdentityV1,
  capacity: NoteSessionQueueCapacityV1,
  recovery: RecoveryStore | null,
  storagePolicy: SidecarStoragePolicyV1,
  persistenceConfig?: RuntimeSessionPersistenceConfigV1,
): RuntimeSessionCompositionV1 {
  const initialSnapshot = createInitialSnapshot(
    recovery !== null,
    persistenceConfig !== undefined,
  );
  let sessionOrder = 0;
  const nextSessionOrder = (): SessionOrder =>
    createSessionOrder(++sessionOrder);
  const history = new RuntimeSessionHistoryV1(
    identity,
    recovery,
    storagePolicy,
    nextSessionOrder,
  );
  const persistence =
    persistenceConfig === undefined
      ? null
      : new RuntimePersistenceV1({
          ...persistenceConfig,
          history,
          identity,
          nextSessionOrder,
        });
  const session = new NoteSessionV1({
    disposeOwned: (): Promise<void> | void => persistence?.dispose(),
    flushHeadless:
      persistence === null
        ? (): Promise<"flushed"> => Promise.resolve("flushed")
        : (): Promise<"failed" | "flushed"> => persistence.flush(),
    history,
    initialSnapshot,
    noteIdentity: identity,
    queue: new NoteSessionQueueV1({
      capacity,
      limits: {
        maxRetainedBytes: SESSION_QUEUE_BYTES,
        maxTurns: SESSION_QUEUE_TURNS,
        reservedCriticalBytes: SESSION_RESERVED_BYTES,
        reservedCriticalTurns: SESSION_RESERVED_TURNS,
      },
    }),
    timer: {
      schedule: (delayMs, callback): (() => void) => {
        const handle = globalThis.setTimeout(callback, delayMs);
        return (): void => globalThis.clearTimeout(handle);
      },
    },
  });
  persistence?.bind(session);
  return Object.freeze({ history, persistence, session });
}

function createInitialSnapshot(
  recoveryAvailable: boolean,
  opening: boolean,
): NoteSessionSnapshotV1 {
  return Object.freeze({
    historyLease: recoveryAvailable
      ? Object.freeze({ kind: "unowned" })
      : Object.freeze({ kind: "blocked", reason: "recovery-unavailable" }),
    lifecycle: opening ? "opening" : "ready",
    persistence: Object.freeze({ kind: "unannotated" }),
    scene: createRuntimeSceneStateV1({
      elements: [],
      groups: [],
      noteAppearance: {
        background: "none",
        contrast: "low",
        horizontalSpacing: "standard",
      },
      objectOrder: [],
      revision: createSceneRevision(0),
    }),
    source: Object.freeze({
      digest: EMPTY_SHA256,
      generation: createSourceGeneration(1),
      kind: "durable",
    }),
  });
}

function sameIdentity(left: NoteIdentityV1, right: NoteIdentityV1): boolean {
  return (
    left.vaultIdHint === right.vaultIdHint &&
    left.vaultRelativeMarkdownPath === right.vaultRelativeMarkdownPath
  );
}
