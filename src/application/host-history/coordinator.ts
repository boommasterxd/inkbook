import {
  applyAnnotationOperationV1,
  createAnnotationDependencyIndexV1,
  validateAnnotationHistoryEntryV1,
} from "../../domain/operations";
import type { RuntimeSceneStateV1 } from "../../domain/scene";
import type { CommandResultV1 } from "../note-session";
import type { HostHistoryMaterializationV1 } from "./materialization";
export type { HostHistoryMaterializationV1 } from "./materialization";
import { HostHistoryIdentityAuthorityV1 } from "./identity-rekey";
import {
  type AcceptedDeliverySnapshotV1,
  type ActionableHistoryEntrySnapshotV1,
  type EditorEpochHighWaterSnapshotV1,
  type HistoryEpoch,
  type HostEffectDeliveryV1,
  type HostEffectDeliveryResultV1,
  type HostHistoryCoordinatorConfigV1,
  type HostHistoryDisposalResultV1,
  type HostHistoryFailureV1,
  type HostHistoryLeaseSnapshotV1,
  type HostHistoryRestoreOptionsV1,
  type HostHistorySnapshotV1,
  type HostTransactionSequence,
  type PrepareHostEffectRequestV1,
  type PrepareHostEffectResultV1,
  type ViewId,
} from "./types";
import { fitsLimits, isValidHistoryEntry } from "./validation";
import {
  editorEpochKey,
  freezeAcknowledgement,
  freezeEntry,
  freezeEnvelope,
  resolveLimits,
} from "./value-objects";
import {
  prospectiveLease,
  rejectDelivery,
  rejectPrepare,
  type OwnedLease,
} from "./results";
import { restoreHostHistory } from "./restore";
import {
  createAnnotationOperationForHistoryV1,
  createEntryTransitionV1,
  createPreparedForwardAttemptV1,
  mapOperationFailure,
  recordRecoveryV1,
} from "./transitions";
import {
  acceptDelivery,
  clearDeliveryState,
  hasAdmittingEntry,
  hasHistoryIdentity,
  releaseEntry,
  releaseEpochDeliveryState,
  releaseRedoBranch,
} from "./retention";
import { validateHostHistoryDeliveryV1 } from "./delivery-validation";

const SNAPSHOT_VERSION = 1 as const;

export class HostHistoryCoordinatorV1 {
  readonly #config: HostHistoryCoordinatorConfigV1;
  readonly #limits: import("./types").HostHistoryLimitsV1;
  readonly #entries = new Map<string, ActionableHistoryEntrySnapshotV1>();
  readonly #accepted = new Map<string, AcceptedDeliverySnapshotV1>();
  readonly #highWater = new Map<string, EditorEpochHighWaterSnapshotV1>();
  #lease: HostHistoryLeaseSnapshotV1 = Object.freeze({ kind: "unowned" });
  readonly #noteIdentity: HostHistoryIdentityAuthorityV1;
  #scene: RuntimeSceneStateV1;
  #dependencies: import("../../domain/operations").AnnotationDependencyIndexV1;
  #nextEpoch = 1;
  #disposed = false;
  #preparing = false;
  #processingDelivery = false;
  #materialization: HostHistoryMaterializationV1 | null = null;

  public constructor(
    config: HostHistoryCoordinatorConfigV1,
    restore: HostHistoryRestoreOptionsV1 = {
      hostEffectsMayBeReachable: false,
    },
  ) {
    this.#config = config;
    this.#noteIdentity = new HostHistoryIdentityAuthorityV1(
      config.noteIdentity,
    );
    this.#scene = config.initialScene;
    const dependencies =
      config.initialDependencies === undefined
        ? createAnnotationDependencyIndexV1(this.#scene)
        : { ok: true as const, value: config.initialDependencies };
    if (!dependencies.ok) {
      throw new TypeError(
        "The initial runtime scene has invalid dependencies.",
      );
    }
    this.#dependencies = dependencies.value;
    this.#limits = resolveLimits(config.limits);
    this.#restoreOrBlock(restore);
  }

  public get scene(): RuntimeSceneStateV1 {
    return this.#scene;
  }

  public get lease(): HostHistoryLeaseSnapshotV1 {
    return this.#lease;
  }

  public setHistoryMaterialization(
    materialization: HostHistoryMaterializationV1 | null,
  ): void {
    if (this.#disposed || this.#processingDelivery) return;
    this.#materialization = materialization;
  }

  public async prepare(
    request: PrepareHostEffectRequestV1,
  ): Promise<PrepareHostEffectResultV1> {
    const unavailable = this.#availabilityFailure();
    if (unavailable !== null) return rejectPrepare(unavailable);
    if (this.#preparing) return rejectPrepare("pending-admission");
    if (!isValidHistoryEntry(request.historyEntry))
      return rejectPrepare("invalid-operation");
    if (
      hasHistoryIdentity(
        this.#entries,
        request.effectId,
        request.historyEntry.historyEntryId,
      )
    )
      return rejectPrepare("duplicate-identity");
    const historyEntry = validateAnnotationHistoryEntryV1(request.historyEntry);
    if (!historyEntry.ok) return rejectPrepare("invalid-operation");
    const leaseResult = prospectiveLease(
      this.#lease,
      this.#nextEpoch,
      request.viewId,
      historyEntry.value.historyEpoch,
    );
    if (leaseResult.kind === "rejected")
      return rejectPrepare(leaseResult.reason);
    if (hasAdmittingEntry(this.#entries))
      return rejectPrepare("pending-admission");

    const operation = createAnnotationOperationForHistoryV1(
      request.operationId,
      historyEntry.value,
      "forward",
      this.#scene.revision,
      historyEntry.value.forward,
      leaseResult.lease.epoch,
    );
    if (operation.kind === "rejected") return rejectPrepare(operation.reason);
    const validation = applyAnnotationOperationV1(
      this.#scene,
      this.#dependencies,
      operation.value,
    );
    if (!validation.ok)
      return rejectPrepare(mapOperationFailure(validation.code));

    const attempt = createPreparedForwardAttemptV1(
      operation.value,
      historyEntry.value,
      this.#config,
    );
    const entry = freezeEntry({
      effectId: request.effectId,
      historyEntry: historyEntry.value,
      lifecycle: "admitting",
      noteIdentity: this.#noteIdentity.current,
      ownerViewId: request.viewId,
      preparedForward: operation.value,
      recoveryAttemptId: attempt.attemptId,
    });
    if (!fitsLimits([...this.#entries.values(), entry], this.#limits)) {
      return rejectPrepare("payload-limit");
    }

    this.#preparing = true;
    try {
      const persisted = await this.#config.recovery.prepareForward(attempt);
      if (!persisted.ok) return rejectPrepare("recovery-failed");
      const unavailableAfterPersistence = this.#availabilityFailure();
      if (unavailableAfterPersistence !== null) {
        return rejectPrepare(unavailableAfterPersistence);
      }
      this.#commitLease(leaseResult.lease);
      this.#entries.set(entry.effectId, entry);
      return Object.freeze({
        envelope: freezeEnvelope(entry, entry.noteIdentity, "forward"),
        intent: operation.value,
        kind: "prepared",
      });
    } catch {
      return rejectPrepare("recovery-failed");
    } finally {
      this.#preparing = false;
    }
  }

  public deliver(
    editorViewId: ViewId,
    ownerViewId: ViewId,
    delivery: HostEffectDeliveryV1,
  ): Promise<HostEffectDeliveryResultV1> {
    return this.#startDelivery(editorViewId, ownerViewId, delivery);
  }

  public deliverInSessionTurn(
    editorViewId: ViewId,
    ownerViewId: ViewId,
    delivery: HostEffectDeliveryV1,
  ): Promise<HostEffectDeliveryResultV1> {
    return this.#startDelivery(editorViewId, ownerViewId, delivery);
  }

  public rekeyNoteIdentity(
    prior: import("./types").NoteIdentityV1,
    replacement: import("./types").NoteIdentityV1,
  ): boolean {
    const blocked =
      this.#disposed || this.#preparing || this.#processingDelivery;
    return this.#noteIdentity.rekey(prior, replacement, blocked);
  }

  public cancelAdmission(
    effectId: string,
    historyEpoch: HistoryEpoch,
  ): boolean {
    const entry = this.#entries.get(effectId);
    if (
      entry?.historyEntry.historyEpoch !== historyEpoch ||
      entry.lifecycle !== "admitting"
    ) {
      return false;
    }
    releaseEntry(this.#entries, entry, this.#config.onRelease);
    if (
      this.#lease.kind === "owned" &&
      this.#lease.epoch === historyEpoch &&
      ![...this.#entries.values()].some(
        (candidate) => candidate.historyEntry.historyEpoch === historyEpoch,
      )
    ) {
      this.#lease = Object.freeze({ kind: "unowned" });
    }
    return true;
  }

  public sequenceHighWater(
    editorViewId: ViewId,
    historyEpoch: HistoryEpoch,
  ): HostTransactionSequence | undefined {
    return this.#highWater.get(editorEpochKey(editorViewId, historyEpoch))
      ?.sequence;
  }

  public releaseUnreachable(
    effectId: string,
    historyEpoch: HistoryEpoch,
  ): boolean {
    const entry = this.#entries.get(effectId);
    if (
      entry?.historyEntry.historyEpoch !== historyEpoch ||
      entry.lifecycle !== "undone"
    ) {
      return false;
    }
    releaseEntry(this.#entries, entry, this.#config.onRelease);
    return true;
  }

  public closeOwner(viewId: ViewId, effectsAreUnreachable: boolean): boolean {
    if (this.#lease.kind !== "owned" || this.#lease.ownerViewId !== viewId) {
      return false;
    }
    const ownedEpoch = this.#lease.epoch;
    const ownedEntries = [...this.#entries.values()].filter(
      (entry) => entry.historyEntry.historyEpoch === ownedEpoch,
    );
    if (
      this.#preparing ||
      this.#processingDelivery ||
      (!effectsAreUnreachable && ownedEntries.length > 0)
    ) {
      this.#block("unrestorable-history");
      return false;
    }
    for (const entry of ownedEntries)
      releaseEntry(this.#entries, entry, this.#config.onRelease);
    releaseEpochDeliveryState(this.#accepted, this.#highWater, ownedEpoch);
    this.#lease = Object.freeze({ kind: "unowned" });
    return true;
  }

  public disposeForReload(
    hostEffectsMayBeReachable: boolean,
  ): HostHistoryDisposalResultV1 {
    if (this.#disposed) return Object.freeze({ kind: "disposed-unreachable" });
    if (
      this.#preparing ||
      this.#processingDelivery ||
      this.#lease.kind === "blocked"
    ) {
      this.#block("unrestorable-history");
      return Object.freeze({ kind: "blocked", reason: "unrestorable-history" });
    }
    if (!hostEffectsMayBeReachable) {
      for (const entry of [...this.#entries.values()])
        releaseEntry(this.#entries, entry, this.#config.onRelease);
      clearDeliveryState(this.#accepted, this.#highWater);
      this.#disposed = true;
      return Object.freeze({ kind: "disposed-unreachable" });
    }
    const snapshot = this.snapshot();
    this.#disposed = true;
    return Object.freeze({ kind: "snapshot", snapshot });
  }

  public snapshot(): HostHistorySnapshotV1 {
    return Object.freeze({
      acceptedDeliveries: Object.freeze([...this.#accepted.values()]),
      entries: Object.freeze([...this.#entries.values()]),
      highWaterMarks: Object.freeze([...this.#highWater.values()]),
      lease: this.#lease,
      nextEpoch: this.#nextEpoch,
      noteIdentity: this.#noteIdentity.current,
      scene: this.#scene,
      version: SNAPSHOT_VERSION,
    });
  }

  async #processDelivery(
    editorViewId: ViewId,
    ownerViewId: ViewId,
    delivery: HostEffectDeliveryV1,
  ): Promise<HostEffectDeliveryResultV1> {
    const validation = validateHostHistoryDeliveryV1(
      {
        accepted: this.#accepted,
        entries: this.#entries,
        highWater: this.#highWater,
        lease: this.#lease,
        scene: this.#scene,
        unavailable: this.#availabilityFailure(),
      },
      editorViewId,
      ownerViewId,
      delivery,
    );
    if (validation.kind !== "ready") return validation.result;
    const materialized = await this.#materializeEntry(
      validation.entry,
      delivery.envelope.direction,
    );
    if (!materialized.ok) {
      this.#block("recovery-failed");
      return rejectDelivery("recovery-failed");
    }
    const transition = createEntryTransitionV1(
      materialized.value,
      delivery.envelope.direction,
      this.#scene,
      this.#dependencies,
      this.#config,
    );
    if (transition.kind === "rejected")
      return rejectDelivery(transition.reason);
    const acknowledgement = freezeAcknowledgement(editorViewId, delivery);
    const recovery = await recordRecoveryV1(
      this.#config,
      transition.value,
      acknowledgement,
    );
    if (!recovery.ok) {
      this.#block("recovery-failed");
      return rejectDelivery("recovery-failed");
    }
    const publication = applyAnnotationOperationV1(
      this.#scene,
      this.#dependencies,
      transition.value.intent,
    );
    if (!publication.ok) {
      this.#block(mapOperationFailure(publication.code));
      return rejectDelivery(mapOperationFailure(publication.code));
    }
    if (materialized.value.lifecycle === "admitting") {
      releaseRedoBranch(
        this.#entries,
        validation.entry.effectId,
        this.#config.onRelease,
      );
    }
    this.#scene = publication.value.scene;
    this.#dependencies = publication.value.dependencies;
    this.#entries.set(
      validation.entry.effectId,
      freezeEntry({
        ...materialized.value,
        lifecycle: transition.value.lifecycle,
      }),
    );
    acceptDelivery(
      this.#highWater,
      this.#accepted,
      validation.key,
      editorViewId,
      delivery,
      transition.value.intent,
    );
    return Object.freeze({
      affectedIds: Object.freeze({
        elementIds: Object.freeze([...publication.value.changes.elementIds]),
        groupIds: Object.freeze([...publication.value.changes.groupIds]),
      }),
      intent: transition.value.intent,
      kind: "accepted",
      recoveryAttempt: recovery.value,
      scene: this.#scene,
    });
  }

  #startDelivery(
    editorViewId: ViewId,
    ownerViewId: ViewId,
    delivery: HostEffectDeliveryV1,
  ): Promise<HostEffectDeliveryResultV1> {
    if (this.#processingDelivery) {
      return Promise.resolve(rejectDelivery("pending-admission"));
    }
    this.#processingDelivery = true;
    return this.#processDelivery(editorViewId, ownerViewId, delivery).finally(
      () => {
        this.#processingDelivery = false;
      },
    );
  }

  async #materializeEntry(
    entry: ActionableHistoryEntrySnapshotV1,
    direction: "forward" | "inverse",
  ): Promise<CommandResultV1<ActionableHistoryEntrySnapshotV1>> {
    return (
      (await this.#materialization?.materialize(entry, direction)) ?? {
        ok: true,
        value: entry,
      }
    );
  }

  #commitLease(lease: OwnedLease): void {
    if (this.#lease.kind === "owned") return;
    clearDeliveryState(this.#accepted, this.#highWater);
    this.#lease = lease;
    this.#nextEpoch += 1;
  }

  #availabilityFailure(): HostHistoryFailureV1 | null {
    if (this.#disposed) return "disposed";
    return this.#lease.kind === "blocked" ? "blocked" : null;
  }

  #block(reason: HostHistoryFailureV1): void {
    this.#lease = Object.freeze({ kind: "blocked", reason });
  }

  #restoreOrBlock(restore: HostHistoryRestoreOptionsV1): void {
    const result = restoreHostHistory(
      restore,
      this.#noteIdentity.current,
      this.#limits,
      this.#entries,
      this.#accepted,
      this.#highWater,
    );
    if (result.kind === "blocked") {
      this.#block("unrestorable-history");
      return;
    }
    if (result.kind === "empty") return;
    const dependencies = createAnnotationDependencyIndexV1(
      result.snapshot.scene,
    );
    if (!dependencies.ok) {
      this.#block("unrestorable-history");
      return;
    }
    this.#scene = result.snapshot.scene;
    this.#dependencies = dependencies.value;
    this.#lease = result.snapshot.lease;
    this.#nextEpoch = result.snapshot.nextEpoch;
  }
}
