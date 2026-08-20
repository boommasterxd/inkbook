import {
  applyAnnotationOperationV1,
  createAnnotationDependencyIndexV1,
  createAnnotationOperationV1,
  validateAnnotationHistoryEntryV1,
  type AnnotationDependencyIndexV1,
  type AnnotationOperationV1,
} from "../../domain/operations";
import type { RuntimeSceneStateV1 } from "../../domain/scene";
import { commandFailure, commandSuccess } from "../note-session/results";
import { parseViewId, type CommandResultV1 } from "../note-session";
import { RECOVERY_STORE_LIMITS_V1 } from "../recovery";
import type { MaterializedRecoveryReplayV1 } from "../source-coordination";
import {
  editorEpochKey,
  freezeEntry,
  freezeNoteIdentity,
} from "./value-objects";
import {
  isPositiveCounter,
  isValidEnvelope,
  isValidSnapshot,
} from "./validation";
import { resolveLimits } from "./value-objects";
import type {
  AcceptedDeliverySnapshotV1,
  ActionableHistoryEntrySnapshotV1,
  EditorEpochHighWaterSnapshotV1,
  HostHistoryLeaseSnapshotV1,
  HostHistoryLimitsV1,
  HostHistorySnapshotV1,
  NoteIdentityV1,
} from "./types";

const SNAPSHOT_VERSION = 1 as const;

export interface ReplayMaterializedRecoveryHistoryRequestV1 {
  readonly hostEffectsMayBeReachable: boolean;
  readonly limits?: Partial<HostHistoryLimitsV1>;
  readonly noteIdentity: NoteIdentityV1;
  readonly replay: readonly MaterializedRecoveryReplayV1[];
  readonly sidecarRootScene: RuntimeSceneStateV1;
}

interface ReplayStateV1 {
  readonly accepted: Map<string, AcceptedDeliverySnapshotV1>;
  dependencies: AnnotationDependencyIndexV1;
  readonly entries: Map<string, ActionableHistoryEntrySnapshotV1>;
  readonly highWater: Map<string, EditorEpochHighWaterSnapshotV1>;
  lease: HostHistoryLeaseSnapshotV1;
  maxEpoch: number;
  readonly noteIdentity: NoteIdentityV1;
  scene: RuntimeSceneStateV1;
  readonly seenAttemptIds: Set<string>;
  readonly seenEffectIds: Set<string>;
  readonly seenHistoryEntryIds: Set<string>;
  readonly seenOperationIds: Set<string>;
}

export function replayMaterializedRecoveryHistory(
  request: ReplayMaterializedRecoveryHistoryRequestV1,
): CommandResultV1<HostHistorySnapshotV1> {
  try {
    const limits = resolveLimits(request.limits);
    const ordered = orderReplay(request.replay);
    if (!ordered.ok) return ordered;
    const dependencies = createAnnotationDependencyIndexV1(
      request.sidecarRootScene,
    );
    if (!dependencies.ok) return unavailable();
    const state = createReplayState(request, dependencies.value);
    for (const item of ordered.value) {
      const applied = applyReplayItem(state, item, limits);
      if (!applied.ok) return applied;
    }
    if (state.maxEpoch === Number.MAX_SAFE_INTEGER) {
      return commandFailure("recovery-limit");
    }
    const snapshot = createSnapshot(state, request.hostEffectsMayBeReachable);
    return isValidSnapshot(snapshot, state.noteIdentity, limits)
      ? commandSuccess(snapshot)
      : unavailable();
  } catch {
    return unavailable();
  }
}

function orderReplay(
  replay: readonly MaterializedRecoveryReplayV1[],
): CommandResultV1<readonly MaterializedRecoveryReplayV1[]> {
  if (replay.length > RECOVERY_STORE_LIMITS_V1.maxNoteRecords) {
    return commandFailure("recovery-limit");
  }
  const orders = new Set<number>();
  for (const item of replay) {
    const order = item.attempt.sessionOrder;
    if (!Number.isSafeInteger(order) || order <= 0 || orders.has(order)) {
      return unavailable();
    }
    orders.add(order);
  }
  return commandSuccess(
    Object.freeze([...replay].sort(compareReplaySessionOrder)),
  );
}

function createReplayState(
  request: ReplayMaterializedRecoveryHistoryRequestV1,
  dependencies: AnnotationDependencyIndexV1,
): ReplayStateV1 {
  return {
    accepted: new Map(),
    dependencies,
    entries: new Map(),
    highWater: new Map(),
    lease: Object.freeze({ kind: "unowned" }),
    maxEpoch: 0,
    noteIdentity: freezeNoteIdentity(request.noteIdentity),
    scene: request.sidecarRootScene,
    seenAttemptIds: new Set(),
    seenEffectIds: new Set(),
    seenHistoryEntryIds: new Set(),
    seenOperationIds: new Set(),
  };
}

function applyReplayItem(
  state: ReplayStateV1,
  item: MaterializedRecoveryReplayV1,
  limits: HostHistoryLimitsV1,
): CommandResultV1<void> {
  const attempt = item.attempt;
  if (
    state.seenAttemptIds.has(attempt.attemptId) ||
    state.seenOperationIds.has(attempt.operationId)
  ) {
    return unavailable();
  }
  state.seenAttemptIds.add(attempt.attemptId);
  state.seenOperationIds.add(attempt.operationId);
  state.maxEpoch = Math.max(state.maxEpoch, attempt.historyEpoch);
  return attempt.kind === "host-recorded-forward"
    ? applyForward(state, attempt, limits)
    : applyDirection(state, attempt);
}

function applyForward(
  state: ReplayStateV1,
  attempt: Extract<
    MaterializedRecoveryReplayV1["attempt"],
    { readonly kind: "host-recorded-forward" }
  >,
  limits: HostHistoryLimitsV1,
): CommandResultV1<void> {
  if (
    attempt.acknowledgement.direction !== "forward" ||
    state.seenEffectIds.has(attempt.acknowledgement.effectId) ||
    state.seenHistoryEntryIds.has(attempt.historyEntryId)
  ) {
    return unavailable();
  }
  const leased = admitForwardLease(state, attempt);
  if (!leased.ok) return leased;
  if (state.entries.size >= limits.maxActionableEntries) {
    return commandFailure("recovery-limit");
  }
  const historyEntry = validateAnnotationHistoryEntryV1({
    forward: attempt.forward,
    historyEntryId: attempt.historyEntryId,
    historyEpoch: attempt.historyEpoch,
    inverse: attempt.inverse,
  });
  if (!historyEntry.ok) return unavailable();
  const operation = createReplayOperation(attempt, "forward", attempt.forward);
  if (!operation.ok) return operation;
  const applied = applyOperation(state, operation.value);
  if (!applied.ok) return applied;
  releaseUndoneBranch(state);
  const entry = freezeEntry({
    effectId: attempt.acknowledgement.effectId,
    historyEntry: historyEntry.value,
    lifecycle: "applied",
    noteIdentity: state.noteIdentity,
    ownerViewId: attempt.acknowledgement.editorViewId,
    preparedForward: operation.value,
    recoveryAttemptId: attempt.attemptId,
  });
  state.entries.set(entry.effectId, entry);
  state.seenEffectIds.add(entry.effectId);
  state.seenHistoryEntryIds.add(entry.historyEntry.historyEntryId);
  return acceptAcknowledgement(state, attempt, operation.value);
}

function applyDirection(
  state: ReplayStateV1,
  attempt: Exclude<
    MaterializedRecoveryReplayV1["attempt"],
    { readonly kind: "host-recorded-forward" }
  >,
): CommandResultV1<void> {
  const undo = attempt.kind === "host-recorded-undo";
  if (attempt.acknowledgement.direction !== (undo ? "inverse" : "forward")) {
    return unavailable();
  }
  const entry = state.entries.get(attempt.acknowledgement.effectId);
  if (
    entry?.historyEntry.historyEntryId !== attempt.historyEntryId ||
    entry.historyEntry.historyEpoch !== attempt.historyEpoch ||
    entry.lifecycle !== (undo ? "applied" : "undone")
  ) {
    return unavailable();
  }
  const pairedHistory = validateAnnotationHistoryEntryV1({
    forward: undo ? entry.historyEntry.forward : attempt.directionPatch,
    historyEntryId: entry.historyEntry.historyEntryId,
    historyEpoch: entry.historyEntry.historyEpoch,
    inverse: undo ? attempt.directionPatch : entry.historyEntry.inverse,
  });
  if (!pairedHistory.ok) return unavailable();
  const direction = undo ? "inverse" : "forward";
  const operation = createReplayOperation(
    attempt,
    direction,
    attempt.directionPatch,
  );
  if (!operation.ok) return operation;
  const applied = applyOperation(state, operation.value);
  if (!applied.ok) return applied;
  state.entries.set(
    entry.effectId,
    freezeEntry({ ...entry, lifecycle: undo ? "undone" : "applied" }),
  );
  return acceptAcknowledgement(state, attempt, operation.value);
}

function admitForwardLease(
  state: ReplayStateV1,
  attempt: Extract<
    MaterializedRecoveryReplayV1["attempt"],
    { readonly kind: "host-recorded-forward" }
  >,
): CommandResultV1<void> {
  if (state.lease.kind === "unowned") {
    state.lease = ownedLease(attempt);
    return commandSuccess(undefined);
  }
  if (state.lease.kind !== "owned") return unavailable();
  if (attempt.historyEpoch < state.lease.epoch) return unavailable();
  if (attempt.historyEpoch > state.lease.epoch) {
    state.entries.clear();
    state.accepted.clear();
    state.highWater.clear();
    state.lease = ownedLease(attempt);
    return commandSuccess(undefined);
  }
  return state.lease.ownerViewId === attempt.acknowledgement.editorViewId
    ? commandSuccess(undefined)
    : unavailable();
}

function ownedLease(
  attempt: Extract<
    MaterializedRecoveryReplayV1["attempt"],
    { readonly kind: "host-recorded-forward" }
  >,
): HostHistoryLeaseSnapshotV1 {
  return Object.freeze({
    epoch: attempt.historyEpoch,
    kind: "owned",
    ownerViewId: attempt.acknowledgement.editorViewId,
  });
}

function createReplayOperation(
  attempt: MaterializedRecoveryReplayV1["attempt"],
  direction: "forward" | "inverse",
  patch: AnnotationOperationV1["patch"],
): CommandResultV1<AnnotationOperationV1> {
  const operation = createAnnotationOperationV1({
    direction,
    expectedSceneRevision: attempt.expectedSceneRevision,
    historyEntryId: attempt.historyEntryId,
    historyEpoch: attempt.historyEpoch,
    operationId: attempt.operationId,
    patch,
  });
  return operation.ok ? commandSuccess(operation.value) : unavailable();
}

function applyOperation(
  state: ReplayStateV1,
  operation: AnnotationOperationV1,
): CommandResultV1<void> {
  const applied = applyAnnotationOperationV1(
    state.scene,
    state.dependencies,
    operation,
  );
  if (!applied.ok) return unavailable();
  state.scene = applied.value.scene;
  state.dependencies = applied.value.dependencies;
  return commandSuccess(undefined);
}

function releaseUndoneBranch(state: ReplayStateV1): void {
  for (const entry of [...state.entries.values()]) {
    if (entry.lifecycle !== "undone") continue;
    state.entries.delete(entry.effectId);
    for (const [key, delivery] of state.accepted) {
      if (delivery.envelope.effectId === entry.effectId) {
        state.accepted.delete(key);
      }
    }
  }
}

function acceptAcknowledgement(
  state: ReplayStateV1,
  attempt: MaterializedRecoveryReplayV1["attempt"],
  intent: AnnotationOperationV1,
): CommandResultV1<void> {
  const acknowledgement = attempt.acknowledgement;
  const key = editorEpochKey(
    acknowledgement.editorViewId,
    attempt.historyEpoch,
  );
  const prior = state.highWater.get(key);
  if (
    !isPositiveCounter(acknowledgement.transactionSequence) ||
    parseViewId(acknowledgement.editorViewId) !==
      acknowledgement.editorViewId ||
    (prior !== undefined &&
      acknowledgement.transactionSequence <= prior.sequence)
  ) {
    return unavailable();
  }
  const envelope = Object.freeze({
    direction: acknowledgement.direction,
    effectId: acknowledgement.effectId,
    historyEntryId: attempt.historyEntryId,
    historyEpoch: attempt.historyEpoch,
    noteIdentity: state.noteIdentity,
  });
  if (!isValidEnvelope(envelope)) return unavailable();
  state.highWater.set(
    key,
    Object.freeze({
      editorViewId: acknowledgement.editorViewId,
      historyEpoch: attempt.historyEpoch,
      sequence: acknowledgement.transactionSequence,
    }),
  );
  state.accepted.set(
    key,
    Object.freeze({
      editorViewId: acknowledgement.editorViewId,
      envelope,
      historyEpoch: attempt.historyEpoch,
      intent,
      sequence: acknowledgement.transactionSequence,
    }),
  );
  return commandSuccess(undefined);
}

function createSnapshot(
  state: ReplayStateV1,
  hostEffectsMayBeReachable: boolean,
): HostHistorySnapshotV1 {
  const nextEpoch = state.maxEpoch + 1;
  const retain = hostEffectsMayBeReachable && state.lease.kind === "owned";
  return Object.freeze({
    acceptedDeliveries: Object.freeze(
      retain ? [...state.accepted.values()] : [],
    ),
    entries: Object.freeze(retain ? [...state.entries.values()] : []),
    highWaterMarks: Object.freeze(retain ? [...state.highWater.values()] : []),
    lease: retain ? state.lease : Object.freeze({ kind: "unowned" }),
    nextEpoch: nextEpoch > 0 && Number.isSafeInteger(nextEpoch) ? nextEpoch : 1,
    noteIdentity: state.noteIdentity,
    scene: state.scene,
    version: SNAPSHOT_VERSION,
  });
}

function compareReplaySessionOrder(
  left: MaterializedRecoveryReplayV1,
  right: MaterializedRecoveryReplayV1,
): number {
  return left.attempt.sessionOrder - right.attempt.sessionOrder;
}

function unavailable<T>(): CommandResultV1<T> {
  return commandFailure("recovery-unavailable");
}
