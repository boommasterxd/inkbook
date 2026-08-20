import { serializeRuntimeSceneStateV1 } from "../../domain/codecs";
import { createSidecarRevision } from "../note-session";
import type {
  FirstSidecarPendingV1,
  NoteSessionSnapshotV1,
} from "../note-session";
import { validateFirstSidecarRecovery } from "../recovery";
import {
  FIRST_SIDECAR_TIMEOUT_MS_V1,
  type FirstSidecarCapturedRevisionV1,
  type FirstSidecarCommandV1,
  type FirstSidecarCompletionResultV1,
  type FirstSidecarCreateResultV1,
  type FirstSidecarHostForwardV1,
  type FirstSidecarPortsV1,
  type FirstSidecarPrepareResultV1,
  type FirstSidecarPreparedDispatchV1,
  type FirstSidecarSourceEvidenceV1,
} from "./first-sidecar-types";
import {
  createFirstSidecarAcknowledgement,
  createFirstSidecarPending,
  createFirstSidecarRecoveryContext,
  createFirstSidecarRevision,
  firstSidecarPendingMatchesSnapshot,
  freezeFirstSidecarCommand,
  freezeFirstSidecarEvidence,
} from "./first-sidecar-values";
import type { InkbookSidecarV1 } from "./types";

interface ActiveFirstSidecarV1 {
  readonly command: FirstSidecarCommandV1;
  readonly controller: AbortController;
  readonly cancelTimer: () => void;
  evidence: FirstSidecarSourceEvidenceV1 | null;
  pending: FirstSidecarPendingV1 | null;
  completion: Promise<FirstSidecarCompletionResultV1> | null;
  settlement: Promise<boolean> | null;
}

const ABORTED = Symbol("first-sidecar-aborted");
const SCENE_REVISION_ONE = 1;

export class FirstSidecarCoordinatorV1<TDispatch> {
  readonly #ports: FirstSidecarPortsV1<TDispatch>;
  #active: ActiveFirstSidecarV1 | null = null;
  #disposed = false;

  public constructor(ports: FirstSidecarPortsV1<TDispatch>) {
    this.#ports = ports;
  }

  public prepare(
    command: FirstSidecarCommandV1,
  ): Promise<FirstSidecarPrepareResultV1<TDispatch>> {
    if (this.#disposed || this.#active !== null) {
      return Promise.resolve(Object.freeze({ kind: "rejected" }));
    }
    const active = this.#createActive(command);
    this.#active = active;
    return this.#runPreflight(active);
  }

  public recordHostForward(
    request: FirstSidecarHostForwardV1,
  ): Promise<FirstSidecarCompletionResultV1> {
    const active = this.#active;
    if (this.#disposed || active?.pending === null || active === null) {
      return Promise.resolve(Object.freeze({ kind: "rejected" }));
    }
    if (!this.#matchesHostForward(active, request)) {
      return Promise.resolve(Object.freeze({ kind: "rejected" }));
    }
    if (active.completion !== null) return active.completion;
    active.completion = this.#runCreate(active, request);
    return active.completion;
  }

  public async cancel(): Promise<boolean> {
    if (this.#active === null) return false;
    await this.#failActive(this.#active);
    return true;
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    if (this.#active !== null) await this.#failActive(this.#active);
    this.#disposed = true;
  }

  async #runPreflight(
    active: ActiveFirstSidecarV1,
  ): Promise<FirstSidecarPrepareResultV1<TDispatch>> {
    if (!this.#ports.admitNewSidecar().ok) {
      active.controller.abort();
      this.#clear(active);
      return Object.freeze({ kind: "rejected" });
    }
    const marker = await this.#awaitAbortable(
      this.#ports.writeMarker(active.command, active.controller.signal),
      active.controller.signal,
    );
    if (marker === ABORTED || marker.kind !== "acknowledged") {
      await this.#failActive(active);
      return Object.freeze({ kind: "drift" });
    }
    const evidence = await this.#awaitAbortable(
      this.#ports.awaitOwnedSourceCheckpoint(
        active.command,
        active.controller.signal,
      ),
      active.controller.signal,
    );
    if (evidence === ABORTED || evidence === null) {
      await this.#failActive(active);
      return Object.freeze({ kind: "drift" });
    }
    active.evidence = freezeFirstSidecarEvidence(evidence);
    const prepared = await this.#prepareInNewTurn(active);
    if (prepared === null) {
      await this.#failActive(active);
      return Object.freeze({ kind: "drift" });
    }
    const pending = active.pending;
    if (pending === null) {
      await this.#failActive(active);
      return Object.freeze({ kind: "drift" });
    }
    return Object.freeze({
      dispatch: prepared.dispatch,
      kind: "prepared",
      pending,
    });
  }

  async #prepareInNewTurn(
    active: ActiveFirstSidecarV1,
  ): Promise<FirstSidecarPreparedDispatchV1<TDispatch> | null> {
    let accepted: FirstSidecarPreparedDispatchV1<TDispatch> | null = null;
    const result = await this.#ports.session.enqueue({
      kind: "command",
      retainedBytes: 0,
      run: async ({ publish, signal, snapshot }) => {
        const evidence = active.evidence;
        if (
          evidence === null ||
          signal.aborted ||
          active.controller.signal.aborted ||
          !this.#isRevalidated(active, evidence, snapshot) ||
          snapshot.persistence.kind !== "unannotated" ||
          snapshot.scene.revision !== 0
        ) {
          return;
        }
        const prepared = await this.#ports.prepareDispatch(
          active.command,
          evidence,
          active.controller.signal,
        );
        if (
          prepared.kind !== "prepared" ||
          isAborted(signal) ||
          isAborted(active.controller.signal) ||
          this.#active !== active
        ) {
          return;
        }
        const pending = createFirstSidecarPending(
          active.command,
          evidence,
          prepared,
        );
        active.pending = pending;
        accepted = prepared;
        publish({
          ...snapshot,
          persistence: { kind: "first-sidecar-pending", pending },
        });
      },
    });
    return result.kind === "completed" ? accepted : null;
  }

  async #runCreate(
    active: ActiveFirstSidecarV1,
    request: FirstSidecarHostForwardV1,
  ): Promise<FirstSidecarCompletionResultV1> {
    const capture = await this.#captureRevision(active, request);
    if (capture === null) {
      await this.#finish(active, "drift");
      return Object.freeze({ kind: "drift" });
    }
    let sidecar: InkbookSidecarV1;
    try {
      sidecar = createFirstSidecarRevision(
        active.command,
        capture,
        this.#ports.nowEpochMs(),
      );
    } catch {
      await this.#finish(active, "drift");
      return Object.freeze({ kind: "drift" });
    }
    if (!this.#ports.admitNewSidecar().ok) {
      await this.#finish(active, "drift");
      return Object.freeze({ kind: "drift" });
    }
    let created: FirstSidecarCreateResultV1;
    try {
      created = await this.#ports.createIfAbsent({
        expectedVaultRelativePath: active.command.expectedVaultRelativePath,
        sidecar,
        signal: active.controller.signal,
      });
    } catch {
      created = { kind: "failed" };
    }
    if (!this.#isCurrent(active)) return Object.freeze({ kind: "drift" });
    if (created.kind === "collision") {
      const published = await this.#finish(active, "conflict");
      return Object.freeze({ kind: published ? "conflict" : "drift" });
    }
    if (created.kind !== "created" || active.controller.signal.aborted) {
      await this.#finish(active, "drift");
      return Object.freeze({ kind: "drift" });
    }
    let acknowledged: { readonly ok: boolean };
    try {
      acknowledged = await this.#ports.acknowledgeRecovery(
        createFirstSidecarAcknowledgement(
          active.command,
          capture,
          created.rawTextSha256,
        ),
      );
    } catch {
      acknowledged = { ok: false };
    }
    if (!this.#isCurrent(active)) return Object.freeze({ kind: "drift" });
    if (!acknowledged.ok) {
      await this.#finish(active, "drift");
      return Object.freeze({ kind: "drift" });
    }
    const published = await this.#finish(active, "clean");
    return Object.freeze({ kind: published ? "acknowledged" : "drift" });
  }

  async #captureRevision(
    active: ActiveFirstSidecarV1,
    request: FirstSidecarHostForwardV1,
  ): Promise<FirstSidecarCapturedRevisionV1 | null> {
    let capture: FirstSidecarCapturedRevisionV1 | null = null;
    const result = await this.#ports.session.enqueue({
      kind: "persistence",
      retainedBytes: 0,
      run: ({ snapshot }) => {
        const pending = active.pending;
        const evidence = active.evidence;
        if (
          pending === null ||
          evidence === null ||
          active.controller.signal.aborted ||
          !this.#isRevalidated(active, evidence, snapshot) ||
          snapshot.scene.revision !== SCENE_REVISION_ONE ||
          !firstSidecarPendingMatchesSnapshot(pending, snapshot) ||
          !this.#ports.admitNewSidecar().ok
        ) {
          return;
        }
        const recovery = validateFirstSidecarRecovery(
          pending,
          request.attempt,
          createFirstSidecarRecoveryContext(active.command, evidence),
        );
        if (!recovery.ok) return;
        capture = Object.freeze({
          evidence,
          pending,
          scene: serializeRuntimeSceneStateV1(snapshot.scene),
        });
      },
    });
    return result.kind === "completed" ? capture : null;
  }

  async #finish(
    active: ActiveFirstSidecarV1,
    state: "clean" | "conflict" | "drift",
  ): Promise<boolean> {
    if (!this.#isCurrent(active)) return false;
    if (active.settlement !== null) return active.settlement;
    active.settlement = this.#publishFinalState(active, state);
    return active.settlement;
  }

  async #publishFinalState(
    active: ActiveFirstSidecarV1,
    state: "clean" | "conflict" | "drift",
  ): Promise<boolean> {
    active.cancelTimer();
    const publication = { completed: false };
    const result = await this.#ports.session.enqueue({
      kind: "recovery-acknowledgement",
      retainedBytes: 0,
      run: ({ publish, snapshot }) => {
        if (!this.#isCurrent(active) || !activePendingMatches(active, snapshot))
          return;
        const evidence = active.evidence;
        if (
          state === "clean" &&
          (evidence === null ||
            !this.#isRevalidated(active, evidence, snapshot))
        ) {
          publish({ ...snapshot, persistence: { kind: "drift" } });
          this.#clear(active);
          return;
        }
        publish({
          ...snapshot,
          persistence:
            state === "clean"
              ? { kind: "clean", sidecarRevision: createSidecarRevision(1) }
              : { kind: state },
        });
        publication.completed = true;
        this.#clear(active);
      },
    });
    if (result.kind !== "completed" || !publication.completed)
      this.#clear(active);
    return result.kind === "completed" && publication.completed;
  }

  async #failActive(active: ActiveFirstSidecarV1): Promise<void> {
    if (!this.#isCurrent(active)) return;
    if (active.settlement !== null) {
      await active.settlement;
      return;
    }
    active.controller.abort();
    active.cancelTimer();
    active.settlement = this.#publishFailure(active);
    await active.settlement;
  }

  async #publishFailure(active: ActiveFirstSidecarV1): Promise<boolean> {
    let published = false;
    const result = await this.#ports.session.enqueue({
      kind: "recovery-acknowledgement",
      retainedBytes: 0,
      run: ({ publish, snapshot }) => {
        if (!this.#isCurrent(active)) return;
        publish({ ...snapshot, persistence: { kind: "drift" } });
        published = true;
        this.#clear(active);
      },
    });
    if (result.kind !== "completed") this.#clear(active);
    return result.kind === "completed" && published;
  }

  #createActive(command: FirstSidecarCommandV1): ActiveFirstSidecarV1 {
    const controller = new AbortController();
    const active = {
      command: freezeFirstSidecarCommand(command),
      completion: null,
      controller,
      evidence: null,
      pending: null,
      settlement: null,
      cancelTimer: (): void => undefined,
    } satisfies ActiveFirstSidecarV1;
    active.cancelTimer = this.#ports.timer.schedule(
      FIRST_SIDECAR_TIMEOUT_MS_V1,
      () => void this.#failActive(active),
    );
    return active;
  }

  #isRevalidated(
    active: ActiveFirstSidecarV1,
    evidence: FirstSidecarSourceEvidenceV1,
    snapshot: NoteSessionSnapshotV1,
  ): boolean {
    return (
      this.#isCurrent(active) &&
      snapshot.lifecycle === "ready" &&
      snapshot.source.kind === "durable" &&
      snapshot.source.generation === evidence.generation &&
      snapshot.source.digest === evidence.digest &&
      this.#ports.revalidate(active.command, evidence, snapshot)
    );
  }

  #matchesHostForward(
    active: ActiveFirstSidecarV1,
    request: FirstSidecarHostForwardV1,
  ): boolean {
    const pending = active.pending;
    const evidence = active.evidence;
    return (
      pending !== null &&
      evidence !== null &&
      validateFirstSidecarRecovery(
        pending,
        request.attempt,
        createFirstSidecarRecoveryContext(active.command, evidence),
      ).ok
    );
  }

  #isCurrent(active: ActiveFirstSidecarV1): boolean {
    return !this.#disposed && this.#active === active;
  }

  #clear(active: ActiveFirstSidecarV1): void {
    if (this.#active !== active) return;
    active.cancelTimer();
    this.#active = null;
  }

  #awaitAbortable<T>(
    promise: Promise<T>,
    signal: AbortSignal,
  ): Promise<T | typeof ABORTED> {
    if (signal.aborted) return Promise.resolve(ABORTED);
    return new Promise((resolve) => {
      const abort = (): void => resolve(ABORTED);
      signal.addEventListener("abort", abort, { once: true });
      void promise.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        () => {
          signal.removeEventListener("abort", abort);
          resolve(ABORTED);
        },
      );
    });
  }
}

function activePendingMatches(
  active: ActiveFirstSidecarV1,
  snapshot: NoteSessionSnapshotV1,
): boolean {
  return (
    active.pending !== null &&
    firstSidecarPendingMatchesSnapshot(active.pending, snapshot)
  );
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}
