import { createSceneRevision } from "../../../src/domain/model";
import { createHistoryEpoch } from "../../../src/domain/operations";
import { createRuntimeSceneStateV1 } from "../../../src/domain/scene";
import { NoteSessionQueueV1 } from "../../../src/application/note-session/queue";
import type { NoteSessionQueueCapacityV1 } from "../../../src/application/note-session/queue";
import {
  NoteSessionRegistryV1,
  type NoteSessionRegistryLimitsV1,
} from "../../../src/application/note-session/registry";
import {
  type HeadlessFlushCompletionV1,
  type HeadlessFlushRequestV1,
  HEADLESS_FLUSH_TIMEOUT_MS_V1,
  type NoteSessionHistoryAuthorityV1,
  type NoteSessionHistoryRekeyReservationV1,
  type NoteSessionTimerV1,
  NoteSessionV1,
} from "../../../src/application/note-session/session";
import {
  createSidecarRevision,
  createSourceGeneration,
  parseSha256Digest,
  parseViewId,
  type NoteIdentityV1,
  type NoteSessionSnapshotV1,
  type ViewId,
} from "../../../src/application/note-session";

const DIGEST_HEX_LENGTH = 64;
const DEFAULT_QUEUE_TURNS = 8;
const DEFAULT_QUEUE_BYTES = 1_024;
const DEFAULT_RESERVED_TURNS = 2;
const DEFAULT_RESERVED_BYTES = 128;
const MAX_TEST_SESSIONS = 2;
export const MAX_TEST_GLOBAL_TURNS = 2;
export const TEST_REGISTRY_RESERVED_TURNS = 1;
export const HEADLESS_TIMEOUT_MS = HEADLESS_FLUSH_TIMEOUT_MS_V1;

export const NOTE_IDENTITY: NoteIdentityV1 = Object.freeze({
  vaultIdHint: "vault",
  vaultRelativeMarkdownPath: "notes/source.md",
});
export const VIEW_A = parseViewId("view-a");
export const VIEW_B = parseViewId("view-b");

export function sessionSnapshot(): NoteSessionSnapshotV1 {
  return {
    historyLease: { kind: "unowned" },
    lifecycle: "ready",
    persistence: { kind: "clean", sidecarRevision: createSidecarRevision(1) },
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
    source: {
      digest: parseSha256Digest("a".repeat(DIGEST_HEX_LENGTH)),
      generation: createSourceGeneration(1),
      kind: "durable",
    },
  };
}

export class FakeHistoryAuthority implements NoteSessionHistoryAuthorityV1 {
  #lease: NoteSessionSnapshotV1["historyLease"] = Object.freeze({
    kind: "unowned",
  });
  public disposeCalls = 0;
  public closeAllowed = true;
  public prepareRekeyAllowed = true;
  public failRekeyCommit = false;
  public rekeyPrepares = 0;
  public rekeyCommits = 0;
  public rekeyRollbacks = 0;
  public onRekeyCommit: (() => void) | undefined;
  public onDispose: (() => void) | undefined;

  public currentLease(): NoteSessionSnapshotV1["historyLease"] {
    return this.#lease;
  }

  public own(viewId: ViewId, epoch: number): void {
    this.#lease = Object.freeze({
      epoch: createHistoryEpoch(epoch),
      kind: "owned",
      ownerViewId: viewId,
    });
  }

  public block(
    reason: Extract<
      NoteSessionSnapshotV1["historyLease"],
      { readonly kind: "blocked" }
    >["reason"],
  ): void {
    this.#lease = Object.freeze({ kind: "blocked", reason });
  }

  public closeOwner(viewId: ViewId): boolean {
    if (this.#lease.kind !== "owned" || this.#lease.ownerViewId !== viewId) {
      return false;
    }
    if (!this.closeAllowed) {
      this.#lease = Object.freeze({
        kind: "blocked",
        reason: "history-unavailable",
      });
      return false;
    }
    this.#lease = Object.freeze({ kind: "unowned" });
    return true;
  }

  public disposeForReload(): void {
    this.disposeCalls += 1;
    this.onDispose?.();
  }

  public prepareNoteIdentityRekey(): NoteSessionHistoryRekeyReservationV1 | null {
    if (!this.prepareRekeyAllowed) return null;
    this.rekeyPrepares += 1;
    let rolledBack = false;
    return Object.freeze({
      commit: (): void => {
        if (this.failRekeyCommit) {
          throw new Error("The fake history rekey commit failed.");
        }
        this.rekeyCommits += 1;
        this.onRekeyCommit?.();
      },
      rollback: (): void => {
        if (rolledBack) return;
        rolledBack = true;
        this.rekeyRollbacks += 1;
      },
    });
  }
}

export class ControlledTimer implements NoteSessionTimerV1 {
  readonly #callbacks = new Set<() => void>();
  public readonly delays: number[] = [];

  public schedule(delayMs: number, callback: () => void): () => void {
    this.delays.push(delayMs);
    this.#callbacks.add(callback);
    return (): void => {
      this.#callbacks.delete(callback);
    };
  }

  public fireAll(): void {
    for (const callback of [...this.#callbacks]) callback();
  }
}

export function createTestSession(
  config: {
    readonly disposeOwned?: () => Promise<void> | void;
    readonly history?: FakeHistoryAuthority;
    readonly timer?: ControlledTimer;
    readonly queue?: NoteSessionQueueV1;
    readonly noteIdentity?: NoteIdentityV1;
    readonly flushHeadless?: (
      request: HeadlessFlushRequestV1,
    ) => Promise<HeadlessFlushCompletionV1>;
  } = {},
): NoteSessionV1 {
  return new NoteSessionV1({
    disposeOwned: config.disposeOwned ?? ((): void => undefined),
    flushHeadless:
      config.flushHeadless ??
      ((): Promise<HeadlessFlushCompletionV1> => Promise.resolve("flushed")),
    history: config.history ?? new FakeHistoryAuthority(),
    initialSnapshot: sessionSnapshot(),
    noteIdentity: config.noteIdentity ?? NOTE_IDENTITY,
    queue:
      config.queue ??
      new NoteSessionQueueV1({
        limits: {
          maxRetainedBytes: DEFAULT_QUEUE_BYTES,
          maxTurns: DEFAULT_QUEUE_TURNS,
          reservedCriticalBytes: DEFAULT_RESERVED_BYTES,
          reservedCriticalTurns: DEFAULT_RESERVED_TURNS,
        },
      }),
    timer: config.timer ?? new ControlledTimer(),
  });
}

export function createTestRegistry(
  config: {
    readonly disposeOwnedFactory?: (
      identity: NoteIdentityV1,
    ) => () => Promise<void> | void;
    readonly limits?: NoteSessionRegistryLimitsV1;
    readonly flushHeadless?: (
      request: HeadlessFlushRequestV1,
    ) => Promise<HeadlessFlushCompletionV1>;
    readonly onCreate?: (session: NoteSessionV1) => void;
    readonly history?: FakeHistoryAuthority;
    readonly historyFactory?: (
      identity: NoteIdentityV1,
    ) => FakeHistoryAuthority;
  } = {},
): NoteSessionRegistryV1 {
  return new NoteSessionRegistryV1({
    createSession: (identity, capacity): NoteSessionV1 => {
      const session = createTestSession({
        ...(config.disposeOwnedFactory === undefined
          ? {}
          : { disposeOwned: config.disposeOwnedFactory(identity) }),
        ...(config.flushHeadless === undefined
          ? {}
          : { flushHeadless: config.flushHeadless }),
        history:
          config.historyFactory?.(identity) ??
          config.history ??
          new FakeHistoryAuthority(),
        noteIdentity: identity,
        queue: createRegistryQueue(capacity),
      });
      config.onCreate?.(session);
      return session;
    },
    limits: config.limits ?? {
      maxQueuedTurns: MAX_TEST_GLOBAL_TURNS,
      maxSessions: MAX_TEST_SESSIONS,
      reservedCriticalTurns: TEST_REGISTRY_RESERVED_TURNS,
    },
  });
}

function createRegistryQueue(
  capacity: NoteSessionQueueCapacityV1,
): NoteSessionQueueV1 {
  return new NoteSessionQueueV1({
    capacity,
    limits: {
      maxRetainedBytes: 512,
      maxTurns: 4,
      reservedCriticalBytes: 128,
      reservedCriticalTurns: 2,
    },
  });
}
