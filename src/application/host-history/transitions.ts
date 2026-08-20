import {
  applyAnnotationOperationV1,
  createAnnotationOperationV1,
  type AnnotationHistoryEntryV1,
  type AnnotationOperationV1,
} from "../../domain/operations";
import type { AnnotationDependencyIndexV1 } from "../../domain/operations";
import type { RuntimeSceneStateV1 } from "../../domain/scene";
import type {
  HostRecordedDirectionAttemptV1,
  PreparedForwardAttemptV1,
} from "../recovery";
import type {
  HostHistoryCoordinatorConfigV1,
  HostEffectAcknowledgementV1,
  HostHistoryFailureV1,
  HostHistoryRecoveryContextV1,
  HistoryEpoch,
} from "./types";
import type { EntryTransition } from "./results";

export type TransitionResult =
  | { readonly kind: "ready"; readonly value: EntryTransition }
  | { readonly kind: "rejected"; readonly reason: HostHistoryFailureV1 };

export function createEntryTransitionV1(
  entry: import("./types").ActionableHistoryEntrySnapshotV1,
  direction: "forward" | "inverse",
  scene: RuntimeSceneStateV1,
  dependencies: AnnotationDependencyIndexV1,
  config: HostHistoryCoordinatorConfigV1,
): TransitionResult {
  if (entry.lifecycle === "admitting" && direction === "forward") {
    return {
      kind: "ready",
      value: {
        intent: entry.preparedForward,
        lifecycle: "applied",
        recovery: {
          attemptId: entry.recoveryAttemptId,
          kind: "forward",
        },
      },
    };
  }
  if (entry.lifecycle === "applied" && direction === "inverse") {
    return createDirectionTransitionV1(
      entry,
      "undo",
      scene,
      dependencies,
      config,
    );
  }
  if (entry.lifecycle === "undone" && direction === "forward") {
    return createDirectionTransitionV1(
      entry,
      "redo",
      scene,
      dependencies,
      config,
    );
  }
  return { kind: "rejected", reason: "lifecycle-mismatch" };
}

export function createPreparedForwardAttemptV1(
  operation: AnnotationOperationV1,
  historyEntry: AnnotationHistoryEntryV1,
  config: HostHistoryCoordinatorConfigV1,
): PreparedForwardAttemptV1 {
  const context = recoveryContext(config);
  return Object.freeze({
    attemptId: context.createRecoveryAttemptId(),
    base: context.base,
    expectedSceneRevision: operation.expectedSceneRevision,
    expectedSourceDigest: context.expectedSourceDigest,
    expectedSourceGeneration: context.expectedSourceGeneration,
    forward: historyEntry.forward,
    historyEntryId: historyEntry.historyEntryId,
    historyEpoch: historyEntry.historyEpoch,
    inverse: historyEntry.inverse,
    kind: "prepared-forward",
    operationId: operation.operationId,
    sessionOrder: context.nextSessionOrder(),
  });
}

export function createAnnotationOperationForHistoryV1(
  operationId: import("../../domain/operations").OperationId,
  historyEntry: AnnotationHistoryEntryV1,
  direction: "forward" | "inverse",
  expectedSceneRevision: number,
  patch: AnnotationHistoryEntryV1["forward"],
  historyEpoch: HistoryEpoch,
):
  | { readonly kind: "ready"; readonly value: AnnotationOperationV1 }
  | { readonly kind: "rejected"; readonly reason: HostHistoryFailureV1 } {
  const result = createAnnotationOperationV1({
    direction,
    expectedSceneRevision,
    historyEntryId: historyEntry.historyEntryId,
    historyEpoch,
    operationId,
    patch,
  });
  return result.ok
    ? { kind: "ready", value: Object.freeze({ ...result.value }) }
    : { kind: "rejected", reason: "invalid-operation" };
}

export function mapOperationFailure(
  code: Exclude<
    import("../../domain/operations").AnnotationOperationResultV1,
    { readonly ok: true }
  >["code"],
): HostHistoryFailureV1 {
  switch (code) {
    case "stale-scene":
      return "revision-mismatch";
    case "resource-limit":
      return "payload-limit";
    case "invalid-operation":
      return "invalid-operation";
  }
}

export async function recordRecoveryV1(
  config: HostHistoryCoordinatorConfigV1,
  transition: EntryTransition,
  acknowledgement: HostEffectAcknowledgementV1,
): Promise<boolean> {
  try {
    if (transition.recovery.kind === "forward") {
      const result = await config.recovery.recordForward(
        transition.recovery
          .attemptId as import("../note-session").RecoveryAttemptId,
        acknowledgement,
      );
      return result.ok;
    }
    const attempt = Object.freeze({
      ...transition.recovery.attempt,
      acknowledgement,
    });
    return (await config.recovery.appendDirection(attempt)).ok;
  } catch {
    return false;
  }
}

function createDirectionTransitionV1(
  entry: import("./types").ActionableHistoryEntrySnapshotV1,
  direction: "undo" | "redo",
  scene: RuntimeSceneStateV1,
  dependencies: AnnotationDependencyIndexV1,
  config: HostHistoryCoordinatorConfigV1,
): TransitionResult {
  const operation = createAnnotationOperationForHistoryV1(
    config.createOperationId(),
    entry.historyEntry,
    direction === "undo" ? "inverse" : "forward",
    scene.revision,
    direction === "undo"
      ? entry.historyEntry.inverse
      : entry.historyEntry.forward,
    entry.historyEntry.historyEpoch,
  );
  if (operation.kind === "rejected") return operation;
  const validation = applyAnnotationOperationV1(
    scene,
    dependencies,
    operation.value,
  );
  if (!validation.ok) {
    return { kind: "rejected", reason: mapOperationFailure(validation.code) };
  }
  const context = recoveryContext(config);
  const attempt: Omit<HostRecordedDirectionAttemptV1, "acknowledgement"> =
    Object.freeze({
      attemptId: context.createRecoveryAttemptId(),
      base: context.base,
      directionPatch: operation.value.patch,
      expectedSceneRevision: operation.value.expectedSceneRevision,
      expectedSourceDigest: context.expectedSourceDigest,
      expectedSourceGeneration: context.expectedSourceGeneration,
      historyEntryId: entry.historyEntry.historyEntryId,
      historyEpoch: entry.historyEntry.historyEpoch,
      kind: direction === "undo" ? "host-recorded-undo" : "host-recorded-redo",
      operationId: operation.value.operationId,
      sessionOrder: context.nextSessionOrder(),
    });
  return {
    kind: "ready",
    value: {
      intent: operation.value,
      lifecycle: direction === "undo" ? "undone" : "applied",
      recovery: { attempt, kind: "direction" },
    },
  };
}

function recoveryContext(
  config: HostHistoryCoordinatorConfigV1,
): HostHistoryRecoveryContextV1 {
  return typeof config.recoveryContext === "function"
    ? config.recoveryContext()
    : config.recoveryContext;
}
