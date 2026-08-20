import { sha256Bytes } from "../../../src/domain/codecs/sha256";
import {
  commandFailure,
  commandSuccess,
} from "../../../src/application/note-session/results";
import { parseSha256Digest } from "../../../src/application/note-session/value-objects";
import type { CommandResultV1 } from "../../../src/application/note-session/types";
import {
  encodeRecoveryRecordV1,
  sameNoteIdentity,
  validateRelocationTransition,
  validateRemovalTransition,
  type FileRelocationRecordV1,
  type DiscardConfirmedNoteRecoveryV1,
  type HostAcknowledgementV1,
  type HostRecordedForwardAttemptV1,
  type PrefixRelocationRecordV1,
  type PreparedForwardAttemptV1,
  type RecoveryStore,
  type RecoverySnapshotV1,
  type RelocationRecordV1,
  type RemovalRecordV1,
} from "../../../src/application/recovery";

type PersistedStep =
  FileRelocationRecordV1["step"] | PrefixRelocationRecordV1["step"];

export interface RecoveryHarnessV1 {
  readonly store: RecoveryStore;
  readonly relocations: Map<string, RelocationRecordV1>;
  readonly removals: Map<string, RemovalRecordV1>;
  crashAfterStep(step: PersistedStep): void;
  crashAfterRemoval(markerState: RemovalRecordV1["markerState"]): void;
}

export function createRecoveryHarness(): RecoveryHarnessV1 {
  const relocations = new Map<string, RelocationRecordV1>();
  const removals = new Map<string, RemovalRecordV1>();
  const attempts = new Map<string, PreparedForwardAttemptV1>();
  const relocationCrashes = new Set<PersistedStep>();
  const removalCrashes = new Set<RemovalRecordV1["markerState"]>();
  const store: RecoveryStore = {
    acknowledgeSidecar: async () => commandSuccess(undefined),
    advanceRelocation: async ({ expected, replacement }) => {
      const validated = validateRelocationTransition({ expected, replacement });
      if (
        !validated.ok ||
        !sameRecord(relocations.get(expected.relocationId), expected)
      ) {
        return commandFailure("sidecar-conflict");
      }
      relocations.set(expected.relocationId, replacement);
      if (relocationCrashes.delete(replacement.step)) throw new Error("crash");
      return commandSuccess(undefined);
    },
    advanceRemoval: async ({ expected, replacement }) => {
      const validated = validateRemovalTransition({ expected, replacement });
      if (
        !validated.ok ||
        !sameRecord(removals.get(expected.removalId), expected)
      ) {
        return commandFailure("sidecar-conflict");
      }
      removals.set(expected.removalId, replacement);
      if (removalCrashes.delete(replacement.markerState))
        throw new Error("crash");
      return commandSuccess(undefined);
    },
    appendDirection: async (attempt) => commandSuccess(attempt),
    appendSourceCheckpoint: async () => commandSuccess(undefined),
    beginRelocation: async (record) => {
      if (relocations.has(record.relocationId))
        return commandFailure("sidecar-conflict");
      relocations.set(record.relocationId, record);
      return commandSuccess(undefined);
    },
    beginRemoval: async (record) => {
      if (removals.has(record.removalId))
        return commandFailure("sidecar-conflict");
      removals.set(record.removalId, record);
      return commandSuccess(undefined);
    },
    completeSaga: async (request) => {
      const records = request.kind === "relocation" ? relocations : removals;
      const record = records.get(request.id);
      if (record === undefined) return commandFailure("sidecar-conflict");
      const encoded = encodeRecoveryRecordV1(record);
      if (!encoded.ok) return encoded;
      const digest = parseSha256Digest(await sha256Bytes(encoded.value));
      if (digest !== request.expectedTerminalRecordSha256) {
        return commandFailure("sidecar-conflict");
      }
      records.delete(request.id);
      return commandSuccess(undefined);
    },
    discardConfirmedNoteRecovery: async (request) =>
      discardConfirmedRecovery(request, relocations, removals),
    dispose: async () => undefined,
    loadNote: async () => commandSuccess(emptySnapshot(relocations, removals)),
    ...retainedRuleRecoveryMethods(),
    ...forwardRecoveryMethods(attempts),
    ...relocationRecoveryMethods(relocations),
    ...removalRecoveryMethods(removals),
    rekeyNote: async (request) => {
      const entry = [...relocations.entries()].find(
        ([, record]) => record.relocationId === request.relocationId,
      );
      if (entry === undefined) return commandFailure("sidecar-conflict");
      const [key, record] = entry;
      if (
        record.kind !== "markdown-file" ||
        !sameNoteIdentity(record.noteIdentity, request.prior)
      ) {
        return commandFailure("sidecar-conflict");
      }
      relocations.set(key, {
        ...record,
        noteIdentity: request.replacement,
        sidecarBase: {
          ...record.sidecarBase,
          markdownPath: request.replacement.vaultRelativeMarkdownPath,
          vaultRelativePath: record.destinationSidecarPath,
        },
      });
      return commandSuccess(undefined);
    },
  };
  return {
    crashAfterRemoval: (markerState) => removalCrashes.add(markerState),
    crashAfterStep: (step) => relocationCrashes.add(step),
    relocations,
    removals,
    store,
  };
}

function removalRecoveryMethods(
  removals: Map<string, RemovalRecordV1>,
): Pick<RecoveryStore, "finalizeRemovalRecovery" | "loadActiveRemoval"> {
  return {
    finalizeRemovalRecovery: async (
      request,
    ): Promise<CommandResultV1<void>> => {
      const durable = removals.get(request.expectedRemoval.removalId);
      if (
        !sameRecord(durable, request.expectedRemoval) ||
        request.expectedRemoval.markerState !== "removed" ||
        !request.expectedRemoval.trashAcknowledged ||
        !request.expectedRemoval.deleteEventAcknowledged ||
        request.expectedAttempts.length > 0 ||
        request.expectedCheckpoints.length > 0
      ) {
        return commandFailure("sidecar-conflict");
      }
      removals.delete(request.expectedRemoval.removalId);
      return commandSuccess(undefined);
    },
    loadActiveRemoval: async ({
      noteIdentity,
    }): ReturnType<RecoveryStore["loadActiveRemoval"]> => {
      const matches = [...removals.values()].filter((record) =>
        sameNoteIdentity(record.noteIdentity, noteIdentity),
      );
      if (matches.length > 1) return commandFailure("recovery-unavailable");
      const removal = matches[0];
      return commandSuccess(
        removal === undefined
          ? null
          : Object.freeze({
              attempts: Object.freeze([]),
              checkpoints: Object.freeze([]),
              removal,
            }),
      );
    },
  };
}

function retainedRuleRecoveryMethods(): Pick<
  RecoveryStore,
  | "loadRetainedPrefixRelocationRules"
  | "removeRetainedPrefixRelocationRuleForMaintenance"
> {
  return {
    loadRetainedPrefixRelocationRules: async () => commandSuccess([]),
    removeRetainedPrefixRelocationRuleForMaintenance: async () =>
      commandSuccess(undefined),
  };
}

function relocationRecoveryMethods(
  relocations: Map<string, RelocationRecordV1>,
): Pick<
  RecoveryStore,
  | "loadPrefixRelocationMember"
  | "loadRelocationById"
  | "loadActivePrefixRelocations"
  | "preparePrefixRelocationPlan"
  | "beginPrefixRelocationBatch"
> {
  return {
    loadActivePrefixRelocations: async () => commandSuccess([]),
    beginPrefixRelocationBatch: async ({
      records,
    }): Promise<CommandResultV1<void>> => {
      for (const record of records)
        relocations.set(record.relocationId, record);
      return commandSuccess(undefined);
    },
    loadPrefixRelocationMember: async () => commandFailure("invalid-command"),
    loadRelocationById: async ({ relocationId }) =>
      commandSuccess(relocations.get(relocationId) ?? null),
    preparePrefixRelocationPlan: async ({ expectedPrefixRecord, members }) =>
      members.length === expectedPrefixRecord.admittedRecordCount
        ? commandSuccess({
            admittedRecordCount: expectedPrefixRecord.admittedRecordCount,
            expectedSettingsRevision:
              expectedPrefixRecord.expectedSettingsRevision,
            generation: expectedPrefixRecord.generation,
            relocationId: expectedPrefixRecord.relocationId,
          })
        : commandFailure("sidecar-conflict"),
  };
}

function discardConfirmedRecovery(
  request: DiscardConfirmedNoteRecoveryV1,
  relocations: ReadonlyMap<string, RelocationRecordV1>,
  removals: ReadonlyMap<string, RemovalRecordV1>,
): CommandResultV1<void> {
  const hasActiveSaga =
    [...relocations.values()].some((record) =>
      "noteIdentity" in record
        ? sameNoteIdentity(record.noteIdentity, request.noteIdentity)
        : false,
    ) ||
    [...removals.values()].some((record) =>
      sameNoteIdentity(record.noteIdentity, request.noteIdentity),
    );
  return hasActiveSaga ||
    request.expectedAttempts.length > 0 ||
    request.expectedCheckpoints.length > 0
    ? commandFailure("sidecar-conflict")
    : commandSuccess(undefined);
}

function forwardRecoveryMethods(
  attempts: Map<string, PreparedForwardAttemptV1>,
): Pick<RecoveryStore, "prepareForward" | "recordForward"> {
  return {
    prepareForward: async (attempt): Promise<CommandResultV1<void>> => {
      attempts.set(attempt.attemptId, attempt);
      return commandSuccess(undefined);
    },
    recordForward: async (attemptId, acknowledgement) =>
      durableForward(attempts.get(attemptId), acknowledgement),
  };
}

function durableForward(
  prepared: PreparedForwardAttemptV1 | undefined,
  acknowledgement: HostAcknowledgementV1,
): ReturnType<typeof commandSuccess<HostRecordedForwardAttemptV1>> {
  if (prepared === undefined) {
    throw new Error("Expected a prepared forward attempt.");
  }
  return commandSuccess(
    Object.freeze({
      ...prepared,
      acknowledgement: Object.freeze({ ...acknowledgement }),
      kind: "host-recorded-forward" as const,
    }),
  );
}

function emptySnapshot(
  relocations: ReadonlyMap<string, RelocationRecordV1>,
  removals: ReadonlyMap<string, RemovalRecordV1>,
): RecoverySnapshotV1 {
  return {
    attempts: [],
    checkpoints: [],
    relocations: [...relocations.values()],
    removals: [...removals.values()],
  };
}

function sameRecord(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface DeferredV1<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

export function deferred<T>(): DeferredV1<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
