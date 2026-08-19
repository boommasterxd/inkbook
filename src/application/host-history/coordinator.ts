import type {
  AcceptedDeliverySnapshotV1,
  ActionableHistoryEntrySnapshotV1,
  EditorEpochHighWaterSnapshotV1,
  HistoryEpoch,
  HostDispatchIntentV1,
  HostEffectAcknowledgementV1,
  HostEffectDeliveryResultV1,
  HostEffectDeliveryV1,
  HostHistoryCoordinatorConfigV1,
  HostHistoryDisposalResultV1,
  HostHistoryFailureV1,
  HostHistoryLeaseSnapshotV1,
  HostHistoryLimitsV1,
  HostHistoryRestoreOptionsV1,
  HostHistorySnapshotV1,
  HostTransactionSequence,
  PrepareHostEffectRequestV1,
  PrepareHostEffectResultV1,
  ProbeAnnotationPatchV1,
  ProbeSceneSnapshotV1,
  ViewId,
} from "./types";
import {
  fitsLimits,
  isPositiveCounter,
  isValidEnvelope,
  isValidPatch,
  sameNoteIdentity,
} from "./validation";
import {
  editorEpochKey,
  freezeAcknowledgement,
  freezeEntry,
  freezeEnvelope,
  freezeIntent,
  freezeNoteIdentity,
  freezePatch,
  freezeScene,
  invertPatch,
  matchesEntry,
  resolveLimits,
  sameEnvelope,
} from "./value-objects";
import {
  invalidDelivery,
  rejectDelivery,
  rejectPrepare,
  type DeliveryValidationResult,
  type EntryTransition,
  type OwnedLease,
  type ProspectiveLeaseResult,
} from "./results";
import { restoreHostHistory } from "./restore";

const SNAPSHOT_VERSION = 1 as const;

export class HostHistoryCoordinatorV1 {
  readonly #config: HostHistoryCoordinatorConfigV1;
  readonly #limits: HostHistoryLimitsV1;
  readonly #entries = new Map<string, ActionableHistoryEntrySnapshotV1>();
  readonly #accepted = new Map<string, AcceptedDeliverySnapshotV1>();
  readonly #highWater = new Map<string, EditorEpochHighWaterSnapshotV1>();
  #lease: HostHistoryLeaseSnapshotV1 = Object.freeze({ kind: "unowned" });
  #scene: ProbeSceneSnapshotV1;
  #nextEpoch = 1;
  #disposed = false;
  #queuedDeliveries = 0;
  #deliveryTail: Promise<void> = Promise.resolve();

  public constructor(
    config: HostHistoryCoordinatorConfigV1,
    restore: HostHistoryRestoreOptionsV1 = {
      hostEffectsMayBeReachable: false,
    },
  ) {
    this.#config = config;
    this.#limits = resolveLimits(config.limits);
    this.#scene = freezeScene(config.initialAnnotation, 0);
    this.#restoreOrBlock(restore);
  }

  public get scene(): ProbeSceneSnapshotV1 {
    return this.#scene;
  }

  public get lease(): HostHistoryLeaseSnapshotV1 {
    return this.#lease;
  }

  public prepare(
    request: PrepareHostEffectRequestV1,
  ): PrepareHostEffectResultV1 {
    const unavailable = this.#availabilityFailure();
    if (unavailable !== null) return rejectPrepare(unavailable);
    if (!isValidPatch(request.patch)) return rejectPrepare("invalid-patch");
    if (request.patch.prior !== this.#scene.annotation) {
      return rejectPrepare("revision-mismatch");
    }
    const leaseResult = this.#prospectiveLease(request.viewId);
    if (leaseResult.kind === "rejected") {
      return rejectPrepare(leaseResult.reason);
    }
    if (this.#hasAdmittingEntry()) return rejectPrepare("pending-admission");
    if (this.#hasIdentity(request.effectId, request.historyEntryId)) {
      return rejectPrepare("duplicate-identity");
    }

    const patch = freezePatch(request.patch);
    const intent = freezeIntent({
      direction: "forward",
      expectedSceneRevision: this.#scene.revision,
      historyEntryId: request.historyEntryId,
      historyEpoch: leaseResult.lease.epoch,
      operationId: this.#config.createOperationId(),
      patch,
    });
    const entry = freezeEntry({
      effectId: request.effectId,
      historyEntryId: request.historyEntryId,
      historyEpoch: leaseResult.lease.epoch,
      lifecycle: "admitting",
      ownerViewId: request.viewId,
      patch,
      preparedForward: intent,
    });
    if (!fitsLimits([...this.#entries.values(), entry], this.#limits)) {
      return rejectPrepare("payload-limit");
    }

    this.#commitLease(leaseResult.lease);
    this.#entries.set(entry.effectId, entry);
    const envelope = freezeEnvelope(
      entry,
      this.#config.noteIdentity,
      "forward",
    );
    return Object.freeze({ kind: "prepared", envelope, intent });
  }

  public deliver(
    editorViewId: ViewId,
    ownerViewId: ViewId,
    delivery: HostEffectDeliveryV1,
  ): Promise<HostEffectDeliveryResultV1> {
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
      entry?.historyEpoch !== historyEpoch ||
      entry.lifecycle !== "admitting"
    ) {
      return false;
    }
    this.#releaseEntry(entry);
    if (
      this.#lease.kind === "owned" &&
      this.#lease.epoch === historyEpoch &&
      ![...this.#entries.values()].some(
        (candidate) => candidate.historyEpoch === historyEpoch,
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
    if (entry?.historyEpoch !== historyEpoch) return false;
    if (entry.lifecycle !== "undone") return false;
    this.#releaseEntry(entry);
    return true;
  }

  public closeOwner(viewId: ViewId, effectsAreUnreachable: boolean): boolean {
    if (this.#lease.kind !== "owned" || this.#lease.ownerViewId !== viewId) {
      return false;
    }
    const ownedEpoch = this.#lease.epoch;
    const ownedEntries = [...this.#entries.values()].filter(
      (entry) => entry.historyEpoch === ownedEpoch,
    );
    if (
      this.#queuedDeliveries > 0 ||
      (!effectsAreUnreachable && ownedEntries.length > 0)
    ) {
      this.#block("unrestorable-history");
      return false;
    }
    for (const entry of ownedEntries) this.#releaseEntry(entry);
    this.#lease = Object.freeze({ kind: "unowned" });
    return true;
  }

  public disposeForReload(
    hostEffectsMayBeReachable: boolean,
  ): HostHistoryDisposalResultV1 {
    if (this.#disposed) return Object.freeze({ kind: "disposed-unreachable" });
    if (this.#queuedDeliveries > 0 || this.#lease.kind === "blocked") {
      this.#block("unrestorable-history");
      return Object.freeze({ kind: "blocked", reason: "unrestorable-history" });
    }
    if (!hostEffectsMayBeReachable) {
      for (const entry of [...this.#entries.values()])
        this.#releaseEntry(entry);
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
    const { entry, key } = validation;
    const transition = this.#createTransition(
      entry,
      delivery.envelope.direction,
    );
    if (transition === null) return rejectDelivery("lifecycle-mismatch");
    if (!this.#patchMatchesScene(transition.intent.patch, transition.intent)) {
      return rejectDelivery("revision-mismatch");
    }
    if (entry.lifecycle === "admitting")
      this.#releaseRedoBranch(entry.effectId);

    const acknowledgement = freezeAcknowledgement(
      editorViewId,
      ownerViewId,
      delivery,
    );
    const recorded = await this.#recordRecovery(
      transition.intent,
      acknowledgement,
    );
    if (!recorded) {
      this.#block("recovery-failed");
      return rejectDelivery("recovery-failed");
    }

    this.#scene = freezeScene(
      transition.intent.patch.replacement,
      this.#scene.revision + 1,
    );
    this.#entries.set(
      entry.effectId,
      freezeEntry({ ...entry, lifecycle: transition.lifecycle }),
    );
    this.#acceptDelivery(key, editorViewId, delivery, transition.intent);
    return Object.freeze({
      intent: transition.intent,
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
    if (!isValidEnvelope(delivery.envelope)) {
      return invalidDelivery("invalid-envelope");
    }
    if (!isPositiveCounter(delivery.transactionSequence)) {
      return invalidDelivery("invalid-sequence");
    }
    if (
      !sameNoteIdentity(
        delivery.envelope.noteIdentity,
        this.#config.noteIdentity,
      )
    ) {
      return invalidDelivery("invalid-envelope");
    }
    if (this.#lease.kind !== "owned") return invalidDelivery("stale-epoch");
    if (this.#lease.epoch !== delivery.envelope.historyEpoch) {
      return invalidDelivery("stale-epoch");
    }
    if (this.#lease.ownerViewId !== ownerViewId)
      return invalidDelivery("non-owner");
    const entry = this.#entries.get(delivery.envelope.effectId);
    if (entry === undefined) return invalidDelivery("entry-not-found");
    if (!matchesEntry(entry, delivery.envelope, ownerViewId)) {
      return invalidDelivery("invalid-envelope");
    }
    const key = editorEpochKey(editorViewId, delivery.envelope.historyEpoch);
    const sequenceResult = this.#validateSequence(key, delivery);
    if (sequenceResult !== null) return sequenceResult;
    return { entry, key, kind: "ready" };
  }

  #validateSequence(
    key: string,
    delivery: HostEffectDeliveryV1,
  ): DeliveryValidationResult | null {
    const mark = this.#highWater.get(key);
    if (mark === undefined || delivery.transactionSequence > mark.sequence) {
      return null;
    }
    if (delivery.transactionSequence < mark.sequence) {
      return invalidDelivery("stale-sequence");
    }
    const accepted = this.#accepted.get(key);
    if (
      accepted !== undefined &&
      sameEnvelope(accepted.envelope, delivery.envelope)
    ) {
      return {
        kind: "complete",
        result: Object.freeze({
          intent: accepted.intent,
          kind: "duplicate",
          scene: this.#scene,
        }),
      };
    }
    return invalidDelivery("out-of-order");
  }

  #createTransition(
    entry: ActionableHistoryEntrySnapshotV1,
    envelopeDirection: "forward" | "inverse",
  ): EntryTransition | null {
    if (entry.lifecycle === "admitting" && envelopeDirection === "forward") {
      return { intent: entry.preparedForward, lifecycle: "applied" };
    }
    if (entry.lifecycle === "applied" && envelopeDirection === "inverse") {
      return {
        intent: this.#freshIntent(entry, "undo", invertPatch(entry.patch)),
        lifecycle: "undone",
      };
    }
    if (entry.lifecycle === "undone" && envelopeDirection === "forward") {
      return {
        intent: this.#freshIntent(entry, "redo", entry.patch),
        lifecycle: "applied",
      };
    }
    return null;
  }

  #freshIntent(
    entry: ActionableHistoryEntrySnapshotV1,
    direction: "undo" | "redo",
    patch: ProbeAnnotationPatchV1,
  ): HostDispatchIntentV1 {
    return freezeIntent({
      direction,
      expectedSceneRevision: this.#scene.revision,
      historyEntryId: entry.historyEntryId,
      historyEpoch: entry.historyEpoch,
      operationId: this.#config.createOperationId(),
      patch,
    });
  }

  #patchMatchesScene(
    patch: ProbeAnnotationPatchV1,
    intent: HostDispatchIntentV1,
  ): boolean {
    return (
      patch.prior === this.#scene.annotation &&
      intent.expectedSceneRevision === this.#scene.revision
    );
  }

  async #recordRecovery(
    intent: HostDispatchIntentV1,
    acknowledgement: HostEffectAcknowledgementV1,
  ): Promise<boolean> {
    try {
      return await this.#config.recovery.record(intent, acknowledgement);
    } catch {
      return false;
    }
  }

  #acceptDelivery(
    key: string,
    editorViewId: ViewId,
    delivery: HostEffectDeliveryV1,
    intent: HostDispatchIntentV1,
  ): void {
    const mark = Object.freeze({
      editorViewId,
      historyEpoch: delivery.envelope.historyEpoch,
      sequence: delivery.transactionSequence,
    });
    const accepted = Object.freeze({
      editorViewId,
      envelope: delivery.envelope,
      historyEpoch: delivery.envelope.historyEpoch,
      intent,
      sequence: delivery.transactionSequence,
    });
    this.#highWater.set(key, mark);
    this.#accepted.set(key, accepted);
  }

  #prospectiveLease(viewId: ViewId): ProspectiveLeaseResult {
    if (this.#lease.kind === "owned") {
      return this.#lease.ownerViewId === viewId
        ? { kind: "accepted", lease: this.#lease }
        : { kind: "rejected", reason: "non-owner" };
    }
    if (this.#lease.kind === "blocked") {
      return { kind: "rejected", reason: "blocked" };
    }
    return {
      kind: "accepted",
      lease: Object.freeze({
        epoch: this.#nextEpoch as HistoryEpoch,
        kind: "owned",
        ownerViewId: viewId,
      }),
    };
  }

  #commitLease(lease: OwnedLease): void {
    if (this.#lease.kind === "owned") return;
    this.#lease = lease;
    this.#nextEpoch += 1;
  }

  #hasAdmittingEntry(): boolean {
    return [...this.#entries.values()].some(
      (entry) => entry.lifecycle === "admitting",
    );
  }

  #hasIdentity(effectId: string, historyEntryId: string): boolean {
    return [...this.#entries.values()].some(
      (entry) =>
        entry.effectId === effectId || entry.historyEntryId === historyEntryId,
    );
  }

  #releaseRedoBranch(currentEffectId: string): void {
    for (const entry of [...this.#entries.values()]) {
      if (entry.effectId !== currentEffectId && entry.lifecycle === "undone") {
        this.#releaseEntry(entry);
      }
    }
  }

  #releaseEntry(entry: ActionableHistoryEntrySnapshotV1): void {
    this.#entries.delete(entry.effectId);
    this.#config.onRelease?.(entry);
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
    this.#scene = result.snapshot.scene;
    this.#lease = result.snapshot.lease;
    this.#nextEpoch = result.snapshot.nextEpoch;
  }
}
