import type { ElementId, GroupId } from "../../domain/model";
import {
  type NoteSessionQueueTurnV1,
  type NoteSessionTurnKindV1,
  type NoteSessionTurnResultV1,
  NoteSessionQueueV1,
  type ReplaceableSessionTurnV1,
} from "./queue";
import {
  createIdentityRekeyControl,
  createIdentityRekeyHandle,
  type IdentityRekeyControlV1,
  type NoteSessionIdentityRekeyHandleV1,
  rejectIdentityRekey,
} from "./identity-rekey";
import type { NoteIdentityV1, NoteSessionSnapshotV1, ViewId } from "./types";

type HistoryLeaseV1 = NoteSessionSnapshotV1["historyLease"];

export interface NoteSessionHistoryAuthorityV1 {
  currentLease(): HistoryLeaseV1;
  closeOwner(viewId: ViewId, effectsAreUnreachable: boolean): boolean;
  disposeForReload(hostEffectsMayBeReachable: boolean): void;
  prepareNoteIdentityRekey(
    prior: NoteIdentityV1,
    replacement: NoteIdentityV1,
  ): NoteSessionHistoryRekeyReservationV1 | null;
}

export interface NoteSessionHistoryRekeyReservationV1 {
  commit(): void;
  rollback(): void;
}

export interface NoteSessionTimerV1 {
  schedule(delayMs: number, callback: () => void): () => void;
}

export type HeadlessFlushCompletionV1 = "flushed" | "failed";
export type HeadlessSessionResultV1 =
  HeadlessFlushCompletionV1 | "timed-out" | "readmitted" | "disposed";

export interface HeadlessFlushRequestV1 {
  readonly signal: AbortSignal;
  readonly snapshot: NoteSessionSnapshotV1;
}

export interface NoteSessionTurnContextV1 {
  readonly signal: AbortSignal;
  readonly snapshot: NoteSessionSnapshotV1;
  readonly publish: (
    snapshot: NoteSessionSnapshotV1,
    affectedIds?: NoteSessionAffectedIdsV1,
  ) => void;
}

export interface NoteSessionAffectedIdsV1 {
  readonly elementIds: readonly ElementId[];
  readonly groupIds: readonly GroupId[];
}

export interface NoteSessionTurnV1 {
  readonly kind: NoteSessionTurnKindV1;
  readonly retainedBytes: number;
  readonly replacement?: ReplaceableSessionTurnV1;
  readonly run: (context: NoteSessionTurnContextV1) => Promise<void> | void;
}

export type NoteSessionListenerV1 = (
  snapshot: NoteSessionSnapshotV1,
  affectedIds: NoteSessionAffectedIdsV1,
) => void;

export interface NoteSessionConfigV1 {
  readonly noteIdentity: NoteIdentityV1;
  readonly initialSnapshot: NoteSessionSnapshotV1;
  readonly queue: NoteSessionQueueV1;
  readonly history: NoteSessionHistoryAuthorityV1;
  readonly timer: NoteSessionTimerV1;
  readonly disposeOwned: () => Promise<void> | void;
  readonly flushHeadless: (
    request: HeadlessFlushRequestV1,
  ) => Promise<HeadlessFlushCompletionV1>;
}

export const HEADLESS_FLUSH_TIMEOUT_MS_V1 = 2_000;

interface ActiveHeadlessFlushV1 {
  readonly controller: AbortController;
  readonly completion: Promise<HeadlessSessionResultV1>;
  readonly settle: (result: HeadlessSessionResultV1) => void;
  cancelTimer: (() => void) | null;
  settled: boolean;
}

const EMPTY_ELEMENT_IDS: readonly ElementId[] = Object.freeze([]);
const EMPTY_GROUP_IDS: readonly GroupId[] = Object.freeze([]);
const EMPTY_AFFECTED_IDS: NoteSessionAffectedIdsV1 = Object.freeze({
  elementIds: EMPTY_ELEMENT_IDS,
  groupIds: EMPTY_GROUP_IDS,
});

export class NoteSessionV1 {
  readonly #config: NoteSessionConfigV1;
  readonly #listeners = new Set<NoteSessionListenerV1>();
  #snapshot: NoteSessionSnapshotV1;
  #noteIdentity: NoteIdentityV1;
  #overlaySuspended = false;
  #headless: ActiveHeadlessFlushV1 | null = null;
  #disposePromise: Promise<void> | null = null;
  #acceptPublications = true;

  public constructor(config: NoteSessionConfigV1) {
    validateConfig(config);
    this.#config = config;
    this.#noteIdentity = Object.freeze({ ...config.noteIdentity });
    this.#snapshot = freezeSnapshot(
      config.initialSnapshot,
      config.history.currentLease(),
    );
  }

  public get snapshot(): NoteSessionSnapshotV1 {
    return this.#snapshot;
  }

  public subscribe(listener: NoteSessionListenerV1): () => void {
    if (this.#snapshot.lifecycle === "disposed") return (): void => undefined;
    this.#listeners.add(listener);
    let active = true;
    return (): void => {
      if (!active) return;
      active = false;
      this.#listeners.delete(listener);
    };
  }

  public enqueue(turn: NoteSessionTurnV1): Promise<NoteSessionTurnResultV1> {
    if (
      this.#overlaySuspended &&
      (turn.kind === "view" || turn.kind === "worker")
    ) {
      return Promise.resolve(
        Object.freeze({ kind: "rejected", reason: "resource-limit" }),
      );
    }
    const queueTurn: NoteSessionQueueTurnV1 = {
      kind: turn.kind,
      retainedBytes: turn.retainedBytes,
      ...(turn.replacement === undefined
        ? {}
        : { replacement: turn.replacement }),
      run: async (signal) => {
        const context = this.#createTurnContext(signal, turn.kind);
        await turn.run(context);
      },
    };
    return this.#config.queue.enqueue(queueTurn);
  }

  public suspendOverlay(): void {
    if (this.#overlaySuspended) return;
    this.#overlaySuspended = true;
    this.#config.queue.cancelPendingReplaceableKinds(["view", "worker"]);
  }

  public readmitOverlay(identity: NoteIdentityV1): boolean {
    if (
      this.#snapshot.lifecycle === "disposed" ||
      !sameIdentity(identity, this.#noteIdentity)
    ) {
      return false;
    }
    this.#overlaySuspended = false;
    const active = this.#headless;
    if (active !== null) this.#finishHeadless(active, "readmitted");
    return true;
  }

  public stageNoteIdentityRekey(
    prior: NoteIdentityV1,
    replacement: NoteIdentityV1,
  ): NoteSessionIdentityRekeyHandleV1 {
    const control = createIdentityRekeyControl();
    const frozenPrior = Object.freeze({ ...prior });
    const frozenReplacement = Object.freeze({ ...replacement });
    const completion = this.enqueue({
      kind: "lifecycle",
      retainedBytes: 0,
      run: () =>
        this.#runIdentityRekey(control, frozenPrior, frozenReplacement),
    });
    void completion.then((result) => {
      if (result.kind === "completed") return;
      control.admitted.resolve(false);
      control.prepared.resolve(false);
      control.committed.resolve(false);
    });
    return createIdentityRekeyHandle(control, completion);
  }

  public closeOwner(
    viewId: ViewId,
    effectsAreUnreachable: boolean,
  ): Promise<NoteSessionTurnResultV1> {
    return this.enqueue({
      kind: "lifecycle",
      retainedBytes: 0,
      run: ({ publish, snapshot }) => {
        this.#config.history.closeOwner(viewId, effectsAreUnreachable);
        publish(snapshot);
      },
    });
  }

  public beginHeadlessFlush(): Promise<HeadlessSessionResultV1> {
    if (this.#snapshot.lifecycle === "disposed") {
      return Promise.resolve("disposed");
    }
    if (this.#headless !== null) return this.#headless.completion;
    this.suspendOverlay();
    const active = this.#createHeadlessFlush();
    this.#headless = active;
    void this.enqueue({
      kind: "lifecycle",
      retainedBytes: 0,
      run: () => this.#startHeadlessFlush(active),
    }).then((result) => {
      if (result.kind === "rejected" || result.kind === "failed") {
        this.#finishHeadless(active, "failed");
      }
    });
    return active.completion;
  }

  public dispose(hostEffectsMayBeReachable: boolean): Promise<void> {
    if (this.#disposePromise !== null) return this.#disposePromise;
    this.#acceptPublications = false;
    this.#overlaySuspended = true;
    if (this.#headless !== null)
      this.#finishHeadless(this.#headless, "disposed");
    this.#publishTerminal("disposing");
    this.#disposePromise = this.#config.queue
      .dispose()
      .then(() => this.#disposeOwners(hostEffectsMayBeReachable));
    return this.#disposePromise;
  }

  async #disposeOwners(hostEffectsMayBeReachable: boolean): Promise<void> {
    try {
      await this.#config.disposeOwned();
    } finally {
      try {
        this.#config.history.disposeForReload(hostEffectsMayBeReachable);
      } finally {
        try {
          this.#publishTerminal("disposed");
        } finally {
          this.#listeners.clear();
        }
      }
    }
  }

  #createTurnContext(
    signal: AbortSignal,
    kind: NoteSessionTurnKindV1,
  ): NoteSessionTurnContextV1 {
    const turnSnapshot = this.#snapshot;
    return Object.freeze({
      publish: (
        snapshot: NoteSessionSnapshotV1,
        affectedIds: NoteSessionAffectedIdsV1 = EMPTY_AFFECTED_IDS,
      ): void => {
        if (this.#overlaySuspended && (kind === "view" || kind === "worker")) {
          return;
        }
        this.#publish(snapshot, affectedIds);
      },
      signal,
      snapshot: turnSnapshot,
    });
  }

  async #runIdentityRekey(
    control: IdentityRekeyControlV1,
    prior: NoteIdentityV1,
    replacement: NoteIdentityV1,
  ): Promise<void> {
    control.admitted.resolve(true);
    if (!(await control.prepareDecision.promise) || !this.#canRekey(prior)) {
      rejectIdentityRekey(control);
      return;
    }
    let reservation: NoteSessionHistoryRekeyReservationV1 | null;
    try {
      reservation = this.#config.history.prepareNoteIdentityRekey(
        prior,
        replacement,
      );
    } catch {
      rejectIdentityRekey(control);
      return;
    }
    if (reservation === null) {
      rejectIdentityRekey(control);
      return;
    }
    control.prepared.resolve(true);
    if (!(await control.commitDecision.promise)) {
      reservation.rollback();
      control.committed.resolve(false);
      return;
    }
    try {
      reservation.commit();
      this.#noteIdentity = replacement;
      control.committed.resolve(true);
    } catch {
      control.committed.resolve(false);
      reservation.rollback();
      return;
    }
    if (await control.finalDecision.promise) return;
    this.#noteIdentity = prior;
    reservation.rollback();
  }

  #canRekey(prior: NoteIdentityV1): boolean {
    return (
      this.#snapshot.lifecycle !== "disposed" &&
      this.#snapshot.lifecycle !== "disposing" &&
      sameIdentity(this.#noteIdentity, prior)
    );
  }

  #publish(
    snapshot: NoteSessionSnapshotV1,
    affectedIds: NoteSessionAffectedIdsV1,
  ): void {
    if (!this.#acceptPublications) return;
    const affected = freezeAffectedIds(affectedIds);
    this.#snapshot = freezeSnapshot(
      snapshot,
      this.#config.history.currentLease(),
    );
    this.#notify(affected);
  }

  #publishTerminal(lifecycle: "disposing" | "disposed"): void {
    this.#snapshot = freezeSnapshot(
      { ...this.#snapshot, lifecycle },
      this.#config.history.currentLease(),
    );
    this.#notify(EMPTY_AFFECTED_IDS);
  }

  #notify(affectedIds: NoteSessionAffectedIdsV1): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(this.#snapshot, affectedIds);
      } catch {
        continue;
      }
    }
  }

  #createHeadlessFlush(): ActiveHeadlessFlushV1 {
    let settle: (result: HeadlessSessionResultV1) => void = missingSettlement;
    const completion = new Promise<HeadlessSessionResultV1>((resolve) => {
      settle = resolve;
    });
    return {
      cancelTimer: null,
      completion,
      controller: new AbortController(),
      settle,
      settled: false,
    };
  }

  #startHeadlessFlush(active: ActiveHeadlessFlushV1): void {
    if (this.#headless !== active || active.settled) return;
    active.cancelTimer = this.#config.timer.schedule(
      HEADLESS_FLUSH_TIMEOUT_MS_V1,
      () => this.#finishHeadless(active, "timed-out"),
    );
    void this.#config
      .flushHeadless({
        signal: active.controller.signal,
        snapshot: this.#snapshot,
      })
      .then(
        (result) => this.#finishHeadless(active, result),
        () => this.#finishHeadless(active, "failed"),
      );
  }

  #finishHeadless(
    active: ActiveHeadlessFlushV1,
    result: HeadlessSessionResultV1,
  ): void {
    if (active.settled) return;
    active.settled = true;
    active.cancelTimer?.();
    active.controller.abort();
    if (this.#headless === active) this.#headless = null;
    active.settle(result);
  }
}

function freezeSnapshot(
  snapshot: NoteSessionSnapshotV1,
  historyLease: HistoryLeaseV1,
): NoteSessionSnapshotV1 {
  return Object.freeze({
    historyLease: Object.freeze({ ...historyLease }),
    lifecycle: snapshot.lifecycle,
    persistence: freezePersistence(snapshot.persistence),
    scene: snapshot.scene,
    source: Object.freeze({ ...snapshot.source }),
  });
}

function missingSettlement(): never {
  throw new Error("A headless settlement callback was not initialized.");
}

function freezePersistence(
  persistence: NoteSessionSnapshotV1["persistence"],
): NoteSessionSnapshotV1["persistence"] {
  if (persistence.kind !== "first-sidecar-pending") {
    return Object.freeze({ ...persistence });
  }
  return Object.freeze({
    kind: persistence.kind,
    pending: Object.freeze({
      ...persistence.pending,
      noteIdentity: Object.freeze({ ...persistence.pending.noteIdentity }),
    }),
  });
}

function freezeAffectedIds(
  ids: NoteSessionAffectedIdsV1,
): NoteSessionAffectedIdsV1 {
  return Object.freeze({
    elementIds: freezeUniqueIds(ids.elementIds),
    groupIds: freezeUniqueIds(ids.groupIds),
  });
}

function freezeUniqueIds<T extends string>(ids: readonly T[]): readonly T[] {
  const unique = new Set<T>();
  for (const id of ids) unique.add(id);
  return Object.freeze([...unique]);
}

function sameIdentity(left: NoteIdentityV1, right: NoteIdentityV1): boolean {
  return (
    left.vaultIdHint === right.vaultIdHint &&
    left.vaultRelativeMarkdownPath === right.vaultRelativeMarkdownPath
  );
}

function validateConfig(config: NoteSessionConfigV1): void {
  if (
    config.noteIdentity.vaultIdHint.length === 0 ||
    config.noteIdentity.vaultRelativeMarkdownPath.length === 0
  ) {
    throw new TypeError("The note session identity is invalid.");
  }
}
