/* eslint-disable @typescript-eslint/no-magic-numbers -- Branded first-revision fixtures require exact counters. */
import { createSceneRevision } from "../../../src/domain/model";
import {
  invertAnnotationPatchV1,
  parseHistoryEntryId,
  parseOperationId,
  type AnnotationPatchV1,
} from "../../../src/domain/operations";
import { createRuntimeSceneStateV1 } from "../../../src/domain/scene";
import {
  createHistoryEpoch,
  createHostTransactionSequence,
  createSessionOrder,
  createSettingsRevision,
  createSourceGeneration,
  parseHostEffectId,
  parseRecoveryAttemptId,
  parseSha256Digest,
  parseSourceCheckpointId,
  parseViewId,
  type NoteSessionSnapshotV1,
  type CommandErrorCodeV1,
  type Sha256Digest,
} from "../../../src/application/note-session";
import { NoteSessionQueueV1 } from "../../../src/application/note-session/queue";
import {
  NoteSessionV1,
  type NoteSessionHistoryAuthorityV1,
  type NoteSessionHistoryRekeyReservationV1,
} from "../../../src/application/note-session/session";
import type {
  HostRecordedForwardAttemptV1,
  SidecarRecoveryAcknowledgementV1,
} from "../../../src/application/recovery";
import { FirstSidecarCoordinatorV1 } from "../../../src/application/persistence/first-sidecar";
import type {
  FirstSidecarCommandV1,
  FirstSidecarCreateRequestV1,
  FirstSidecarCreateResultV1,
  FirstSidecarPortsV1,
  FirstSidecarSourceEvidenceV1,
  FirstSidecarTimerPortV1,
} from "../../../src/application/persistence/first-sidecar-types";
import { rectangle, valueOf } from "../../domain/operations/support";

const IDENTIFIER_PAYLOAD = "00000000000000000000000000";
const DIGEST_LENGTH = 64;
const QUEUE_LIMIT = 16;
const QUEUE_BYTES = 4_096;
const RESERVED_TURNS = 4;
const RESERVED_BYTES = 512;
type PolicyGateFailure = Extract<
  CommandErrorCodeV1,
  "read-only-mode" | "relocation-pending"
>;

const DIGEST_A = digest("a");
const DIGEST_B = digest("b");
export const DIGEST_C = digest("c");
const NOTE = Object.freeze({
  vaultIdHint: "vault",
  vaultRelativeMarkdownPath: "Notes/Course.md",
});
export const COMMAND: FirstSidecarCommandV1 = Object.freeze({
  expectedSettingsRevision: createSettingsRevision(1),
  expectedVaultRelativePath: "Notes/Course.inkbook.json",
  historyEntryId: parseHistoryEntryId(`he_${IDENTIFIER_PAYLOAD}`),
  noteIdentity: NOTE,
  operationId: parseOperationId(`op_${IDENTIFIER_PAYLOAD}`),
  storageLayout: Object.freeze({ kind: "adjacent" }),
});
export const EVIDENCE: FirstSidecarSourceEvidenceV1 = Object.freeze({
  checkpointId: parseSourceCheckpointId(`scp_${IDENTIFIER_PAYLOAD}`),
  digest: DIGEST_B,
  generation: createSourceGeneration(2),
});
const ATTEMPT_ID = parseRecoveryAttemptId(`ra_${IDENTIFIER_PAYLOAD}`);

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

class ControlledTimer implements FirstSidecarTimerPortV1 {
  readonly callbacks = new Set<() => void>();

  public schedule(_delayMs: number, callback: () => void): () => void {
    this.callbacks.add(callback);
    return (): void => {
      this.callbacks.delete(callback);
    };
  }

  public fire(): void {
    for (const callback of [...this.callbacks]) callback();
  }
}

class HistoryAuthority implements NoteSessionHistoryAuthorityV1 {
  public disposed = false;

  public currentLease(): NoteSessionSnapshotV1["historyLease"] {
    return Object.freeze({ kind: "unowned" });
  }

  public closeOwner(): boolean {
    return true;
  }

  public disposeForReload(): void {
    this.disposed = true;
  }

  public prepareNoteIdentityRekey(): NoteSessionHistoryRekeyReservationV1 {
    return Object.freeze({
      commit: (): void => undefined,
      rollback: (): void => undefined,
    });
  }
}

export interface FirstSidecarHarness {
  readonly coordinator: FirstSidecarCoordinatorV1<string>;
  readonly session: NoteSessionV1;
  readonly command: FirstSidecarCommandV1;
  readonly events: string[];
  readonly creates: FirstSidecarCreateRequestV1[];
  readonly createStarted: Promise<true>;
  readonly acknowledgementStarted: Promise<true>;
  readonly acknowledgements: SidecarRecoveryAcknowledgementV1[];
  readonly timer: ControlledTimer;
  currentIdentityValid: boolean;
  createResult:
    FirstSidecarCreateResultV1 | Deferred<FirstSidecarCreateResultV1>;
  acknowledgementOk: boolean;
  gateChecks: number;
  setAdmissionCheckHook(hook: ((check: number) => void) | null): void;
  setNewSidecarGateFailure(failure: PolicyGateFailure | null): void;
  setAcknowledgementGate(gate: Deferred<{ readonly ok: boolean }> | null): void;
  acknowledgeMarker(): void;
  failMarker(): void;
  rejectMarker(): void;
  acknowledgeCheckpoint(): Promise<void>;
  publishHostForward(): Promise<void>;
}

export function createFirstSidecarHarness(): FirstSidecarHarness {
  const marker = deferred<
    { readonly kind: "acknowledged" } | { readonly kind: "failed" }
  >();
  const checkpoint = deferred<FirstSidecarSourceEvidenceV1 | null>();
  const createStarted = deferred<true>();
  const acknowledgementStarted = deferred<true>();
  const acknowledgementState: {
    gate: Deferred<{ readonly ok: boolean }> | null;
  } = { gate: null };
  const policyGateState = createPolicyGateState();
  const timer = new ControlledTimer();
  const session = createSession();
  const events: string[] = [];
  const creates: FirstSidecarCreateRequestV1[] = [];
  const acknowledgements: SidecarRecoveryAcknowledgementV1[] = [];
  const harness = {
    acknowledgementOk: true,
    acknowledgementStarted: acknowledgementStarted.promise,
    acknowledgements,
    command: COMMAND,
    coordinator: undefined as unknown as FirstSidecarCoordinatorV1<string>,
    createResult: { kind: "created", rawTextSha256: DIGEST_C },
    createStarted: createStarted.promise,
    creates,
    currentIdentityValid: true,
    events,
    gateChecks: 0,
    session,
    timer,
    acknowledgeMarker: (): void => marker.resolve({ kind: "acknowledged" }),
    failMarker: (): void => marker.resolve({ kind: "failed" }),
    rejectMarker: (): void => marker.reject(new Error("marker rejected")),
    setAdmissionCheckHook: (hook): void => {
      policyGateState.admissionCheckHook = hook;
    },
    setAcknowledgementGate: (gate): void => {
      acknowledgementState.gate = gate;
    },
    setNewSidecarGateFailure: (failure): void => {
      policyGateState.failure = failure;
    },
    acknowledgeCheckpoint: async (): Promise<void> => {
      await publishSource(session, EVIDENCE);
      checkpoint.resolve(EVIDENCE);
    },
    publishHostForward: (): Promise<void> => publishSceneRevisionOne(session),
  } satisfies FirstSidecarHarness;
  const ports: FirstSidecarPortsV1<string> = {
    admitNewSidecar: () => {
      harness.gateChecks += 1;
      policyGateState.admissionCheckHook?.(harness.gateChecks);
      return policyGateState.failure === null
        ? { ok: true, value: undefined }
        : { code: policyGateState.failure, ok: false };
    },
    acknowledgeRecovery: async (value) => {
      events.push("acknowledge-recovery");
      acknowledgements.push(value);
      acknowledgementStarted.resolve(true);
      const gate = acknowledgementState.gate;
      if (gate !== null) {
        return gate.promise;
      }
      return { ok: harness.acknowledgementOk };
    },
    awaitOwnedSourceCheckpoint: async () => {
      events.push("checkpoint");
      return checkpoint.promise;
    },
    createIfAbsent: async (request) => {
      events.push("create");
      creates.push(request);
      createStarted.resolve(true);
      const result = harness.createResult;
      return isDeferredCreate(result) ? result.promise : result;
    },
    nowEpochMs: () => 1_755_734_400_000,
    prepareDispatch: async () => {
      events.push("prepare-dispatch");
      return {
        dispatch: "host-forward",
        kind: "prepared",
        recoveryAttemptId: ATTEMPT_ID,
      };
    },
    revalidate: () => harness.currentIdentityValid,
    session,
    timer,
    writeMarker: async () => {
      events.push("marker");
      return marker.promise;
    },
  };
  harness.coordinator = new FirstSidecarCoordinatorV1(ports);
  return harness;
}

export function hostForwardAttempt(
  overrides: Partial<HostRecordedForwardAttemptV1> = {},
): HostRecordedForwardAttemptV1 {
  const forward = createPatch();
  return {
    acknowledgement: {
      direction: "forward",
      editorViewId: parseViewId("view-a"),
      effectId: parseHostEffectId(`eff_${IDENTIFIER_PAYLOAD}`),
      transactionSequence: createHostTransactionSequence(1),
    },
    attemptId: ATTEMPT_ID,
    base: {
      markdownPath: NOTE.vaultRelativeMarkdownPath,
      rawTextSha256: null,
      revision: null,
      vaultRelativePath: COMMAND.expectedVaultRelativePath,
    },
    expectedSceneRevision: createSceneRevision(0),
    expectedSourceDigest: EVIDENCE.digest,
    expectedSourceGeneration: EVIDENCE.generation,
    forward,
    historyEntryId: COMMAND.historyEntryId,
    historyEpoch: createHistoryEpoch(1),
    inverse: invertAnnotationPatchV1(forward),
    kind: "host-recorded-forward",
    operationId: COMMAND.operationId,
    sessionOrder: createSessionOrder(2),
    ...overrides,
  };
}

export function createDeferred<T>(): Deferred<T> {
  return deferred<T>();
}

export async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createSession(): NoteSessionV1 {
  return new NoteSessionV1({
    disposeOwned: (): void => undefined,
    flushHeadless: async () => "flushed",
    history: new HistoryAuthority(),
    initialSnapshot: initialSnapshot(),
    noteIdentity: NOTE,
    queue: new NoteSessionQueueV1({
      limits: {
        maxRetainedBytes: QUEUE_BYTES,
        maxTurns: QUEUE_LIMIT,
        reservedCriticalBytes: RESERVED_BYTES,
        reservedCriticalTurns: RESERVED_TURNS,
      },
    }),
    timer,
  });
}

const timer: FirstSidecarTimerPortV1 = Object.freeze({
  schedule: (): (() => void) => () => undefined,
});

function initialSnapshot(): NoteSessionSnapshotV1 {
  return {
    historyLease: { kind: "unowned" },
    lifecycle: "ready",
    persistence: { kind: "unannotated" },
    scene: createRuntimeSceneStateV1({
      elements: [],
      groups: [],
      noteAppearance: {
        background: "none",
        contrast: "medium",
        horizontalSpacing: "standard",
      },
      objectOrder: [],
      revision: createSceneRevision(0),
    }),
    source: {
      digest: DIGEST_A,
      generation: createSourceGeneration(1),
      kind: "durable",
    },
  };
}

async function publishSource(
  session: NoteSessionV1,
  evidence: FirstSidecarSourceEvidenceV1,
): Promise<void> {
  await session.enqueue({
    kind: "source",
    retainedBytes: 0,
    run: ({ publish, snapshot }) =>
      publish({
        ...snapshot,
        source: {
          digest: evidence.digest,
          generation: evidence.generation,
          kind: "durable",
        },
      }),
  });
}

async function publishSceneRevisionOne(session: NoteSessionV1): Promise<void> {
  const element = rectangle(0, 1);
  await session.enqueue({
    kind: "history",
    retainedBytes: 0,
    run: ({ publish, snapshot }) =>
      publish({
        ...snapshot,
        scene: createRuntimeSceneStateV1({
          elements: [element],
          groups: [],
          noteAppearance: snapshot.scene.noteAppearance,
          objectOrder: [element.elementId],
          revision: createSceneRevision(1),
        }),
      }),
  });
}

function createPatch(): AnnotationPatchV1 {
  const element = rectangle(0, 1);
  return {
    elements: [valueOf(element)],
    kind: "create-elements",
    placement: {
      movedElementIds: [element.elementId],
      predecessorId: null,
      successorId: null,
    },
  };
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  if (resolvePromise === undefined || rejectPromise === undefined)
    throw new Error("Deferred initialization failed.");
  return Object.freeze({
    promise,
    reject: rejectPromise,
    resolve: resolvePromise,
  });
}

function digest(character: string): Sha256Digest {
  return parseSha256Digest(character.repeat(DIGEST_LENGTH));
}

function isDeferredCreate(
  value: FirstSidecarCreateResultV1 | Deferred<FirstSidecarCreateResultV1>,
): value is Deferred<FirstSidecarCreateResultV1> {
  return "promise" in value;
}

function createPolicyGateState(): {
  admissionCheckHook: ((check: number) => void) | null;
  failure: PolicyGateFailure | null;
} {
  return { admissionCheckHook: null, failure: null };
}
