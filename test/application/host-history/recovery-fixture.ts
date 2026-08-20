import type { CommandResultV1 } from "../../../src/application/note-session";
import { commandSuccess } from "../../../src/application/note-session";
import type {
  HostRecordedDirectionAttemptV1,
  PreparedForwardAttemptV1,
  RecoveryStore,
} from "../../../src/application/recovery";

export interface RecoveryFixtureOptions {
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
    appendDirection: async (attempt): Promise<CommandResultV1<void>> => {
      observations.directionAttempts.push(attempt);
      observations.operationIds.push(attempt.operationId);
      observations.expectedSceneRevisions.push(attempt.expectedSceneRevision);
      if (state.directionFailures > 0) {
        state.directionFailures -= 1;
        return failure();
      }
      observations.recordedDirections.push(attempt.acknowledgement.direction);
      return success(undefined);
    },
    appendSourceCheckpoint: async () => success(undefined),
    beginRelocation: async () => success(undefined),
    beginRemoval: async () => success(undefined),
    completeSaga: async () => success(undefined),
    dispose: async () => undefined,
    loadNote: async () =>
      success({ attempts: [], checkpoints: [], relocations: [], removals: [] }),
    prepareForward: async (attempt): Promise<CommandResultV1<void>> => {
      observations.prepareAttempts.push(attempt);
      observations.operationIds.push(attempt.operationId);
      observations.expectedSceneRevisions.push(attempt.expectedSceneRevision);
      if (state.prepareFailures > 0) {
        state.prepareFailures -= 1;
        return failure();
      }
      return success(undefined);
    },
    recordForward: async (
      _attemptId,
      acknowledgement,
    ): Promise<CommandResultV1<void>> => {
      state.resolveRecordStarted();
      if (options.holdRecord === true) await state.recordRelease;
      if (state.recordFailures > 0) {
        state.recordFailures -= 1;
        return failure();
      }
      observations.recordedDirections.push(acknowledgement.direction);
      return success(undefined);
    },
    rekeyNote: async () => success(undefined),
  };
}

function success<T>(value: T): CommandResultV1<T> {
  return commandSuccess(value);
}

function failure(): CommandResultV1<never> {
  return Object.freeze({ code: "recovery-unavailable" as const, ok: false });
}
