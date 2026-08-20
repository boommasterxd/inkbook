/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact history identifiers, sequences, and digests are deterministic fixtures. */
import type {
  CommandResultV1,
  HostTransactionSequence,
  NoteIdentityV1,
  SessionOrder,
  ViewId,
} from "../../../src/application/note-session";
import {
  commandSuccess,
  createHostTransactionSequence,
  parseHostEffectId,
  parseRecoveryAttemptId,
  parseSha256Digest,
  parseViewId,
} from "../../../src/application/note-session";
import type {
  HostHistoryCoordinatorConfigV1,
  HostHistoryRecoveryContextV1,
  HostEffectDeliveryV1,
  HostEffectEnvelopeV1,
  PrepareHostEffectResultV1,
} from "../../../src/application/host-history";
import { HostHistoryCoordinatorV1 } from "../../../src/application/host-history";
import { createSceneRevision } from "../../../src/domain/model";
import {
  createAnnotationHistoryEntryV1,
  createHistoryEpoch,
  parseHistoryEntryId,
  parseOperationId,
} from "../../../src/domain/operations";
import { createRuntimeSceneStateV1 } from "../../../src/domain/scene";
import type {
  HostRecordedForwardAttemptV1,
  HostRecordedDirectionAttemptV1,
  PreparedForwardAttemptV1,
  RecoveryStore,
} from "../../../src/application/recovery";
import { rectangleElement } from "../../domain/model/support";

export const HOST_HISTORY_NOTE: NoteIdentityV1 = Object.freeze({
  vaultIdHint: "vault",
  vaultRelativeMarkdownPath: "Notes/history.md",
});
export const HOST_HISTORY_PANE_A = parseViewId("view_a");
export const HOST_HISTORY_PANE_B = parseViewId("view_b");
export const HOST_HISTORY_EDITOR_A = parseViewId("editor_a");
export const HOST_HISTORY_EDITOR_B = parseViewId("editor_b");
const NOTE_APPEARANCE = Object.freeze({
  background: "none" as const,
  contrast: "medium" as const,
  horizontalSpacing: "standard" as const,
});

export interface HostHistoryHarnessOptions extends RecoveryFixtureOptions {
  readonly maxActionableEntries?: number;
  readonly noteIdentity?: NoteIdentityV1;
  readonly onRelease?: HostHistoryCoordinatorConfigV1["onRelease"];
  readonly restore?: ConstructorParameters<typeof HostHistoryCoordinatorV1>[1];
}

export interface HostHistoryHarness {
  readonly coordinator: HostHistoryCoordinatorV1;
  readonly prepareAttempts: readonly PreparedForwardAttemptV1[];
  readonly directionAttempts: readonly HostRecordedDirectionAttemptV1[];
  readonly recordedDirections: readonly ("forward" | "inverse")[];
  readonly operationIds: readonly string[];
  readonly expectedSceneRevisions: readonly number[];
  readonly recordStarted: Promise<void>;
  readonly releaseRecord: () => void;
  readonly prepareStarted: Promise<void>;
  readonly releasePrepare: () => void;
}

export function createHostHistoryHarness(
  options: HostHistoryHarnessOptions = {},
): HostHistoryHarness {
  let operationNumber = 0;
  let attemptNumber = 0;
  let sessionOrder = 0;
  let resolveRecordStarted = (): void => undefined;
  let resolveRecord: (() => void) | undefined;
  let resolvePrepareStarted = (): void => undefined;
  let resolvePrepare: (() => void) | undefined;
  const recordStarted = new Promise<void>((resolve) => {
    resolveRecordStarted = resolve;
  });
  const recordRelease = new Promise<void>((resolve) => {
    resolveRecord = resolve;
  });
  const prepareStarted = new Promise<void>((resolve) => {
    resolvePrepareStarted = resolve;
  });
  const prepareRelease = new Promise<void>((resolve) => {
    resolvePrepare = resolve;
  });
  const observations: RecoveryFixtureObservations = {
    prepareAttempts: [],
    directionAttempts: [],
    recordedDirections: [],
    operationIds: [],
    expectedSceneRevisions: [],
  };
  const recoveryState: RecoveryFixtureState = {
    prepareFailures: options.prepareFailures ?? 0,
    recordFailures: options.recordFailures ?? 0,
    directionFailures: options.directionFailures ?? 0,
    resolveRecordStarted,
    recordRelease,
    resolvePrepareStarted,
    prepareRelease,
  };
  const recovery = createRecovery(options, recoveryState, observations);
  const recoveryContext: HostHistoryRecoveryContextV1 = {
    base: {
      markdownPath: HOST_HISTORY_NOTE.vaultRelativeMarkdownPath,
      rawTextSha256: null,
      revision: null,
      vaultRelativePath: HOST_HISTORY_NOTE.vaultRelativeMarkdownPath,
    },
    createRecoveryAttemptId: () =>
      parseRecoveryAttemptId(identifier("ra", ++attemptNumber)),
    expectedSourceDigest: parseSha256Digest("0".repeat(64)),
    expectedSourceGeneration:
      1 as import("../../../src/application/note-session").SourceGeneration,
    nextSessionOrder: () => ++sessionOrder as SessionOrder,
  };
  const config: HostHistoryCoordinatorConfigV1 = {
    createOperationId: () =>
      parseOperationId(identifier("op", ++operationNumber)),
    initialScene: createRuntimeSceneStateV1({
      elements: [],
      groups: [],
      noteAppearance: NOTE_APPEARANCE,
      objectOrder: [],
      revision: createSceneRevision(0),
    }),
    noteIdentity: options.noteIdentity ?? HOST_HISTORY_NOTE,
    recovery,
    recoveryContext,
    ...(options.onRelease === undefined
      ? {}
      : { onRelease: options.onRelease }),
    ...(options.maxActionableEntries === undefined
      ? {}
      : { limits: { maxActionableEntries: options.maxActionableEntries } }),
  };
  return {
    coordinator: new HostHistoryCoordinatorV1(config, options.restore),
    ...observations,
    prepareStarted,
    recordStarted,
    releasePrepare: () => resolvePrepare?.(),
    releaseRecord: () => resolveRecord?.(),
  };
}

export async function prepareHostHistory(
  coordinator: HostHistoryCoordinatorV1,
  viewId: ViewId,
  epoch: number,
  elementIndex: number,
): Promise<Extract<PrepareHostEffectResultV1, { readonly kind: "prepared" }>> {
  const result = prepareHostHistoryResult(
    coordinator,
    viewId,
    epoch,
    elementIndex,
  );
  const resolved = await result;
  if (resolved.kind !== "prepared") {
    throw new Error(`Preparation failed: ${resolved.reason}`);
  }
  return resolved;
}

export function prepareHostHistoryResult(
  coordinator: HostHistoryCoordinatorV1,
  viewId: ViewId,
  epoch: number,
  elementIndex: number,
): Promise<PrepareHostEffectResultV1> {
  const element = rectangleElement(elementIndex);
  const predecessorId =
    coordinator.scene.objectOrder.get(
      coordinator.scene.objectOrder.length - 1,
    ) ?? null;
  const historyEntry = createAnnotationHistoryEntryV1({
    forward: {
      elements: [
        {
          binding: element.binding,
          elementId: element.elementId,
          geometry: element.geometry,
          kind: element.kind,
          style: element.style,
        },
      ],
      kind: "create-elements",
      placement: {
        movedElementIds: [element.elementId],
        predecessorId,
        successorId: null,
      },
    },
    historyEntryId: parseHistoryEntryId(identifier("he", elementIndex + epoch)),
    historyEpoch: createHistoryEpoch(epoch),
  });
  if (!historyEntry.ok) throw new Error("History fixture is invalid.");
  return coordinator.prepare({
    effectId: parseHostEffectId(identifier("eff", elementIndex + epoch)),
    historyEntry: historyEntry.value,
    operationId: parseOperationId(identifier("op", 100 + elementIndex + epoch)),
    viewId,
  });
}

export interface RecoveryFixtureOptions {
  readonly holdPrepare?: boolean;
  readonly holdRecord?: boolean;
  readonly prepareFailures?: number;
  readonly recordFailures?: number;
  readonly directionFailures?: number;
}

export interface RecoveryFixtureState {
  prepareFailures: number;
  recordFailures: number;
  directionFailures: number;
  readonly resolveRecordStarted: () => void;
  readonly recordRelease: Promise<void>;
  readonly resolvePrepareStarted?: () => void;
  readonly prepareRelease?: Promise<void>;
}

export interface RecoveryFixtureObservations {
  readonly prepareAttempts: PreparedForwardAttemptV1[];
  readonly directionAttempts: HostRecordedDirectionAttemptV1[];
  readonly recordedDirections: ("forward" | "inverse")[];
  readonly operationIds: string[];
  readonly expectedSceneRevisions: number[];
}

export function createRecovery(
  options: RecoveryFixtureOptions,
  state: RecoveryFixtureState,
  observations: RecoveryFixtureObservations,
): RecoveryStore {
  return {
    acknowledgeSidecar: async () => success(undefined),
    advanceRelocation: async () => success(undefined),
    advanceRemoval: async () => success(undefined),
    appendDirection: async (
      attempt,
    ): Promise<CommandResultV1<HostRecordedDirectionAttemptV1>> => {
      observations.directionAttempts.push(attempt);
      observations.operationIds.push(attempt.operationId);
      observations.expectedSceneRevisions.push(attempt.expectedSceneRevision);
      if (state.directionFailures > 0) {
        state.directionFailures -= 1;
        return failure();
      }
      observations.recordedDirections.push(attempt.acknowledgement.direction);
      return success(attempt);
    },
    appendSourceCheckpoint: async () => success(undefined),
    beginRelocation: async () => success(undefined),
    beginPrefixRelocationBatch: async () => success(undefined),
    beginRemoval: async () => success(undefined),
    completeSaga: async () => success(undefined),
    dispose: async () => undefined,
    discardConfirmedNoteRecovery: async () => success(undefined),
    finalizeRemovalRecovery: async () => success(undefined),
    loadActiveRemoval: async () => success(null),
    loadActivePrefixRelocations: async () => success([]),
    loadRetainedPrefixRelocationRules: async () => success([]),
    loadPrefixRelocationMember: async () => failure(),
    loadRelocationById: async () => success(null),
    loadNote: async () =>
      success({ attempts: [], checkpoints: [], relocations: [], removals: [] }),
    removeRetainedPrefixRelocationRuleForMaintenance: async () =>
      success(undefined),
    prepareForward: async (attempt): Promise<CommandResultV1<void>> => {
      observations.prepareAttempts.push(attempt);
      observations.operationIds.push(attempt.operationId);
      observations.expectedSceneRevisions.push(attempt.expectedSceneRevision);
      state.resolvePrepareStarted?.();
      if (options.holdPrepare === true) await state.prepareRelease;
      if (state.prepareFailures > 0) {
        state.prepareFailures -= 1;
        return failure();
      }
      return success(undefined);
    },
    preparePrefixRelocationPlan: async ({ expectedPrefixRecord }) =>
      success({
        admittedRecordCount: expectedPrefixRecord.admittedRecordCount,
        expectedSettingsRevision: expectedPrefixRecord.expectedSettingsRevision,
        generation: expectedPrefixRecord.generation,
        relocationId: expectedPrefixRecord.relocationId,
      }),
    recordForward: async (
      attemptId,
      acknowledgement,
    ): Promise<CommandResultV1<HostRecordedForwardAttemptV1>> => {
      state.resolveRecordStarted();
      if (options.holdRecord === true) await state.recordRelease;
      if (state.recordFailures > 0) {
        state.recordFailures -= 1;
        return failure();
      }
      observations.recordedDirections.push(acknowledgement.direction);
      const prepared = observations.prepareAttempts.find(
        (attempt) => attempt.attemptId === attemptId,
      );
      if (prepared === undefined) return failure();
      return success(
        Object.freeze({
          ...prepared,
          acknowledgement: Object.freeze({ ...acknowledgement }),
          base: Object.freeze({ ...prepared.base }),
          kind: "host-recorded-forward" as const,
        }),
      );
    },
    rekeyNote: async () => success(undefined),
  };
}

export function historyDelivery(
  envelope: HostEffectEnvelopeV1,
  sequence: number,
): HostEffectDeliveryV1 {
  return Object.freeze({
    envelope,
    transactionSequence:
      sequence === 0
        ? (sequence as HostTransactionSequence)
        : createHostTransactionSequence(sequence),
  });
}

export function invertHistoryEnvelope(
  envelope: HostEffectEnvelopeV1,
): HostEffectEnvelopeV1 {
  return Object.freeze({
    ...envelope,
    direction: envelope.direction === "forward" ? "inverse" : "forward",
  });
}

function success<T>(value: T): CommandResultV1<T> {
  return commandSuccess(value);
}

function failure(): CommandResultV1<never> {
  return Object.freeze({ code: "recovery-unavailable" as const, ok: false });
}

function identifier(prefix: string, index: number): string {
  return `${prefix}_${index.toString(16).padStart(26, "0")}`;
}
