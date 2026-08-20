import {
  applyAnnotationOperationV1,
  createAnnotationDependencyIndexV1,
  validateAnnotationHistoryEntryV1,
} from "../../domain/operations";
import type { RuntimeSceneStateV1 } from "../../domain/scene";
import { isValidNoteIdentity as isValidRecoveryNoteIdentity } from "../recovery/validation";
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
import {
  fitsLimits,
  isPositiveCounter,
  isValidEnvelope,
  isValidHistoryEntry,
  sameNoteIdentity,
} from "./validation";
import {
  editorEpochKey,
  freezeAcknowledgement,
  freezeEntry,
  freezeEnvelope,
  freezeNoteIdentity,
  matchesEntry,
  resolveLimits,
} from "./value-objects";
import {
  invalidDelivery,
  rejectDelivery,
  rejectPrepare,
  type DeliveryValidationResult,
  type OwnedLease,
  type ProspectiveLeaseResult,
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
  validateSequence,
} from "./retention";

const SNAPSHOT_VERSION = 1 as const;

export class HostHistoryCoordinatorV1 {
  readonly #config: HostHistoryCoordinatorConfigV1;
  readonly #limits: import("./types").HostHistoryLimitsV1;
  readonly #entries = new Map<string, ActionableHistoryEntrySnapshotV1>();
  readonly #accepted = new Map<string, AcceptedDeliverySnapshotV1>();
  readonly #highWater = new Map<string, EditorEpochHighWaterSnapshotV1>();
  #lease: HostHistoryLeaseSnapshotV1 = Object.freeze({ kind: "unowned" });
  #scene: RuntimeSceneStateV1;
  #dependencies: import("../../domain/operations").AnnotationDependencyIndexV1;
  #nextEpoch = 1;
  #disposed = false;
  #preparing = false;
  #queuedDeliveries = 0;
  #deliveryTail: Promise<void> = Promise.resolve();

  public constructor(
    config: HostHistoryCoordinatorConfigV1,
    restore: HostHistoryRestoreOptionsV1 = {
      hostEffectsMayBeReachable: false,
    },
  ) {
    if (!isValidRecoveryNoteIdentity(config.noteIdentity)) {
      throw new TypeError("The host history note identity is invalid.");
    }
    this.#config = config;
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
    const leaseResult = this.#prospectiveLease(
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
      this.#commitLease(leaseResult.lease);
      this.#entries.set(entry.effectId, entry);
      return Object.freeze({
        envelope: freezeEnvelope(entry, this.#config.noteIdentity, "forward"),
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
    if (this.#queuedDeliveries >= this.#limits.maxActionableEntries) {
      return Promise.resolve(rejectDelivery("payload-limit"));
    }
    this.#queuedDeliveries += 1;
    const result = this.#deliveryTail.then(() =>
      this.#processDelivery(editorViewId, ownerViewId, delivery),
    );
    this.#deliveryTail = result.then(
      () => this.#finishDelivery(),
      () => this.#finishDelivery(),
    );
    return result;
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
      this.#queuedDeliveries > 0 ||
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
      this.#queuedDeliveries > 0 ||
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
      noteIdentity: freezeNoteIdentity(this.#config.noteIdentity),
      scene: this.#scene,
      version: SNAPSHOT_VERSION,
    });
  }

  async #processDelivery(
    editorViewId: ViewId,
    ownerViewId: ViewId,
    delivery: HostEffectDeliveryV1,
  ): Promise<HostEffectDeliveryResultV1> {
    const validation = this.#validateDelivery(
      editorViewId,
      ownerViewId,
      delivery,
    );
    if (validation.kind !== "ready") return validation.result;
    const transition = createEntryTransitionV1(
      validation.entry,
      delivery.envelope.direction,
      this.#scene,
      this.#dependencies,
      this.#config,
    );
    if (transition.kind === "rejected")
      return rejectDelivery(transition.reason);
    const acknowledgement = freezeAcknowledgement(editorViewId, delivery);
    if (
      !(await recordRecoveryV1(this.#config, transition.value, acknowledgement))
    ) {
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
    if (validation.entry.lifecycle === "admitting") {
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
        ...validation.entry,
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
      intent: transition.value.intent,
      kind: "accepted",
      scene: this.#scene,
    });
  }

  #validateDelivery(
    editorViewId: ViewId,
    ownerViewId: ViewId,
    delivery: HostEffectDeliveryV1,
  ): DeliveryValidationResult {
    const unavailable = this.#availabilityFailure();
    if (unavailable !== null) return invalidDelivery(unavailable);
    if (!isValidEnvelope(delivery.envelope))
      return invalidDelivery("invalid-envelope");
    if (!isPositiveCounter(delivery.transactionSequence))
      return invalidDelivery("invalid-sequence");
    if (
      !sameNoteIdentity(
        delivery.envelope.noteIdentity,
        this.#config.noteIdentity,
      )
    )
      return invalidDelivery("invalid-envelope");
    if (this.#lease.kind !== "owned") return invalidDelivery("stale-epoch");
    if (this.#lease.epoch !== delivery.envelope.historyEpoch)
      return invalidDelivery("stale-epoch");
    if (this.#lease.ownerViewId !== ownerViewId)
      return invalidDelivery("non-owner");
    const entry = this.#entries.get(delivery.envelope.effectId);
    if (entry === undefined) return invalidDelivery("entry-not-found");
    if (!matchesEntry(entry, delivery.envelope, ownerViewId))
      return invalidDelivery("invalid-envelope");
    const key = editorEpochKey(editorViewId, delivery.envelope.historyEpoch);
    const sequenceResult = validateSequence(
      this.#highWater,
      this.#accepted,
      key,
      delivery,
      this.#scene,
    );
    if (sequenceResult !== null) return sequenceResult;
    return { entry, key, kind: "ready" };
  }

  #prospectiveLease(
    viewId: ViewId,
    historyEpoch: HistoryEpoch,
  ): ProspectiveLeaseResult {
    if (this.#lease.kind === "owned") {
      if (this.#lease.ownerViewId !== viewId) {
        return { kind: "rejected", reason: "non-owner" };
      }
      return this.#lease.epoch === historyEpoch
        ? { kind: "accepted", lease: this.#lease }
        : { kind: "rejected", reason: "stale-epoch" };
    }
    if (this.#lease.kind === "blocked") {
      return { kind: "rejected", reason: "blocked" };
    }
    if (historyEpoch !== this.#nextEpoch) {
      return { kind: "rejected", reason: "stale-epoch" };
    }
    return {
      kind: "accepted",
      lease: Object.freeze({
        epoch: historyEpoch,
        kind: "owned",
        ownerViewId: viewId,
      }),
    };
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

  #finishDelivery(): void {
    this.#queuedDeliveries -= 1;
  }

  #restoreOrBlock(restore: HostHistoryRestoreOptionsV1): void {
    const result = restoreHostHistory(
      restore,
      this.#config.noteIdentity,
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
