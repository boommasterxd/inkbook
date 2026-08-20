import {
  createHostTransactionSequence,
  createRandomSourceCheckpointIdV1,
  type NoteSessionV1,
  type NoteSessionTurnResultV1,
  type SessionOrder,
  type Sha256Digest,
  type SourceGeneration,
  type ViewId,
} from "../../application/note-session";
import type {
  RecoveryStore,
  SidecarBaseIdentityV1,
} from "../../application/recovery";
import {
  createMarkdownSourceCoordinator,
  createSourceDigestStreamingSha256PortV1,
  digestImmutableSourceDocumentV1,
  immutableSourceDocumentRetainedBytesV1,
  materializeImmutableSourceDocumentV1,
  type MarkdownSourceCoordinatorV1,
  type SourceCheckpointOperationV1,
  type MarkdownSourceStateV1,
} from "../../application/source-coordination";
import type {
  SourceDigestWorkPortV1,
  SourceMapWorkPortV1,
} from "../../application/source-coordination/work-ports";
import type { FirstSidecarSourceEvidenceV1 } from "../../application/persistence";
import type { EditorSourceTransitionV1 } from "./editor-history/bridge";
import type { RuntimeMarkerCheckpointCorrelationV1 } from "./runtime-first-sidecar";
import { runtimeCheckpointSchedulerV1 } from "./runtime-persistence-open";
import { provesOwnedMarkerTransitionV1 } from "./runtime-source-marker-evidence";
import { RuntimeSourceMarkerObservationsV1 } from "./runtime-source-marker-observations";

const OFFSET_MAP_SPAN_BYTES = Number("32");

export interface RuntimePersistenceSourceOptionsV1 {
  readonly digest: Sha256Digest;
  readonly generation: SourceGeneration;
  readonly initialMarkdown: string;
  readonly nextSessionOrder: () => SessionOrder;
  readonly onDurable: (checkpoint: SourceCheckpointOperationV1) => void;
  readonly recovery: RecoveryStore;
  readonly readBase: () => SidecarBaseIdentityV1;
  readonly session: NoteSessionV1;
  readonly sourceDigestWorkPort: SourceDigestWorkPortV1;
  readonly sourceMapWorkPort: SourceMapWorkPortV1;
}

export class RuntimePersistenceSourceV1 {
  readonly #coordinator: MarkdownSourceCoordinatorV1;
  readonly #options: RuntimePersistenceSourceOptionsV1;
  readonly #views = new Map<
    ViewId,
    Readonly<{ digest: Sha256Digest; generation: SourceGeneration }>
  >();
  #lastCheckpoint: FirstSidecarSourceEvidenceV1 | null = null;
  #ownedSequence = 0;
  readonly #markers = new RuntimeSourceMarkerObservationsV1();

  private constructor(
    options: RuntimePersistenceSourceOptionsV1,
    coordinator: MarkdownSourceCoordinatorV1,
  ) {
    this.#options = options;
    this.#coordinator = coordinator;
  }

  public static async create(
    options: RuntimePersistenceSourceOptionsV1,
  ): Promise<RuntimePersistenceSourceV1 | null> {
    let owner: RuntimePersistenceSourceV1 | null = null;
    const created = await createMarkdownSourceCoordinator({
      createCheckpointId: () => createRandomSourceCheckpointIdV1(),
      digestPort: createSourceDigestStreamingSha256PortV1(
        options.sourceDigestWorkPort,
      ),
      initialDigest: options.digest,
      initialGeneration: options.generation,
      initialMarkdown: options.initialMarkdown,
      nextSessionOrder: options.nextSessionOrder,
      onDurableCheckpoint: (checkpoint) => {
        if (owner !== null) owner.#acceptDurable(checkpoint);
      },
      onSourceStateChange: (state) => {
        if (owner !== null && state.kind === "reattaching") {
          void owner.#publishReattachment(state.targetDigest);
        }
      },
      readBase: options.readBase,
      recoveryStore: options.recovery,
      scheduler: runtimeCheckpointSchedulerV1(),
      sourceDigestWorkPort: options.sourceDigestWorkPort,
      sourceMapWorkPort: options.sourceMapWorkPort,
    });
    if (!created.ok) return null;
    owner = new RuntimePersistenceSourceV1(options, created.value);
    return owner;
  }

  public get durableSource(): Readonly<{
    digest: Sha256Digest;
    generation: SourceGeneration;
  }> {
    return this.#coordinator.durableSource;
  }

  public get durableUtf16Length(): number {
    return this.#coordinator.durableSource.snapshot.markdown.length;
  }

  public get currentSourceNode(): import("../../application/source-coordination").SourceMapGraphNodeV1 {
    return this.#coordinator.currentSource;
  }

  public attach(viewId: ViewId): void {
    this.#views.set(viewId, this.#coordinator.currentSource);
  }

  public detach(viewId: ViewId): void {
    this.#views.delete(viewId);
    this.#coordinator.detachView(viewId);
  }

  public beginObservedMarker(
    correlation: RuntimeMarkerCheckpointCorrelationV1,
  ): boolean {
    return this.#markers.begin(correlation);
  }

  public cancelObservedMarker(
    correlation: RuntimeMarkerCheckpointCorrelationV1,
  ): void {
    this.#markers.cancel(correlation);
  }

  public accept(viewId: ViewId, transition: EditorSourceTransitionV1): void {
    const markerCorrelation = this.#markers.candidate;
    const completion = this.#enqueueTransition(
      viewId,
      transition,
      markerCorrelation,
    );
    if (markerCorrelation !== null) {
      void completion.then(() => {
        this.#markers.rememberClaim(markerCorrelation, {
          completion,
          priorDigest: markerCorrelation.priorSourceDigest,
          priorGeneration: markerCorrelation.priorSourceGeneration,
          viewId,
        });
      });
    }
    void completion.then((result) => {
      if (result.kind === "rejected" || result.kind === "failed") {
        void this.#publishReattachment(this.#coordinator.currentSource.digest);
      }
    });
  }

  public async awaitObservedMarkerCheckpoint(
    signal: AbortSignal,
    correlation: RuntimeMarkerCheckpointCorrelationV1,
  ): Promise<FirstSidecarSourceEvidenceV1 | null> {
    if (isAbortRequested(signal) || !this.#matchesPriorSource(correlation))
      return null;
    const observation = await this.#markers.wait(signal, correlation);
    if (observation === null || isAbortRequested(signal)) return null;
    const result = await observation.completion;
    if (result.kind !== "completed" || isAbortRequested(signal)) return null;
    if (!(await this.force()) || isAbortRequested(signal)) return null;
    const checkpoint = this.#lastCheckpoint;
    return checkpoint !== null &&
      checkpoint.digest !== correlation.priorSourceDigest &&
      Number(checkpoint.generation) ===
        Number(correlation.priorSourceGeneration) + 1
      ? checkpoint
      : null;
  }

  #enqueueTransition(
    viewId: ViewId,
    transition: EditorSourceTransitionV1,
    markerCorrelation: RuntimeMarkerCheckpointCorrelationV1 | null,
  ): Promise<NoteSessionTurnResultV1> {
    const {
      hostTransactionSequence,
      offsetMap,
      priorDocument,
      replacementDocument,
    } = transition;
    return this.#options.session.enqueue({
      kind: "source",
      retainedBytes:
        immutableSourceDocumentRetainedBytesV1(replacementDocument) +
        offsetMap.spans.length * OFFSET_MAP_SPAN_BYTES,
      run: async ({ publish, signal, snapshot }) => {
        const token =
          this.#views.get(viewId) ?? this.#coordinator.currentSource;
        const priorDigest = await digestImmutableSourceDocumentV1(
          priorDocument,
          this.#options.sourceDigestWorkPort,
          signal,
        );
        if (!priorDigest.ok || priorDigest.value !== token.digest) {
          this.#markers.reject(markerCorrelation);
          publish({
            ...snapshot,
            source: {
              kind: "reattaching",
              targetDigest: priorDigest.ok ? priorDigest.value : token.digest,
            },
          });
          return;
        }
        const ownedMetadataChange = this.#claimMarkerCorrelation(
          markerCorrelation,
          token,
          transition,
        );
        const replacement =
          materializeImmutableSourceDocumentV1(replacementDocument);
        if (!replacement.ok || signal.aborted) {
          this.#markers.reject(markerCorrelation);
          publish({
            ...snapshot,
            source: reattachingSource(token.digest),
          });
          return;
        }
        const admitted = await this.#coordinator.admit({
          hostTransactionSequence,
          offsetMap,
          ownedMetadataChange,
          priorDigest: token.digest,
          priorGeneration: token.generation,
          replacementMarkdown: replacement.value.markdown,
          viewId,
        });
        if (!admitted.ok) {
          publish({
            ...snapshot,
            source: reattachingSource(
              sourceFailureTarget(this.#coordinator.sourceState, token.digest),
            ),
          });
          return;
        }
        this.#views.set(viewId, admitted.value);
        publish({
          ...snapshot,
          source: {
            generation: this.#coordinator.currentSource.generation,
            kind: "checkpoint-pending",
          },
        });
      },
    });
  }

  #claimMarkerCorrelation(
    candidate: RuntimeMarkerCheckpointCorrelationV1 | null,
    token: Readonly<{ digest: Sha256Digest; generation: SourceGeneration }>,
    transition: EditorSourceTransitionV1,
  ): boolean {
    if (candidate === null) return false;
    const current = this.#coordinator.currentSource;
    if (
      this.#markers.candidate !== candidate ||
      token.digest !== candidate.priorSourceDigest ||
      Number(token.generation) !== Number(candidate.priorSourceGeneration) ||
      current.digest !== token.digest ||
      !provesOwnedMarkerTransitionV1({
        expectedLocator: candidate.command.expectedVaultRelativePath,
        offsetMap: transition.offsetMap,
        prior: transition.priorDocument,
        replacement: transition.replacementDocument,
      })
    ) {
      this.#markers.reject(candidate);
      return false;
    }
    return this.#markers.claim(candidate);
  }

  #matchesPriorSource(
    correlation: RuntimeMarkerCheckpointCorrelationV1,
  ): boolean {
    const source = this.#coordinator.durableSource;
    return (
      source.digest === correlation.priorSourceDigest &&
      Number(source.generation) === Number(correlation.priorSourceGeneration)
    );
  }

  public async force(): Promise<boolean> {
    return (await this.#coordinator.beginForcedBarrier().completion).ok;
  }

  public async createOwnedCheckpoint(
    signal: AbortSignal,
  ): Promise<FirstSidecarSourceEvidenceV1 | null> {
    const viewId = this.#views.keys().next().value;
    if (viewId === undefined || signal.aborted) return null;
    const source = this.#coordinator.currentSource;
    const admitted = await this.#coordinator.admit({
      hostTransactionSequence: createHostTransactionSequence(
        ++this.#ownedSequence,
      ),
      offsetMap: { spans: [] },
      ownedMetadataChange: true,
      priorDigest: source.digest,
      priorGeneration: source.generation,
      replacementMarkdown: source.snapshot.markdown,
      viewId,
    });
    if (!admitted.ok || aborted(signal)) return null;
    const barrier = await this.#coordinator.beginForcedBarrier().completion;
    const checkpoint = this.#lastCheckpoint;
    return barrier.ok && checkpoint?.generation === barrier.value.generation
      ? checkpoint
      : null;
  }

  public dispose(): void {
    this.#coordinator.dispose();
    this.#views.clear();
    this.#markers.dispose();
  }

  #acceptDurable(checkpoint: SourceCheckpointOperationV1): void {
    this.#lastCheckpoint = Object.freeze({
      checkpointId: checkpoint.checkpointId,
      digest: checkpoint.replacementDigest,
      generation: checkpoint.replacementGeneration,
    });
    this.#options.onDurable(checkpoint);
    const completion = this.#options.session.enqueue({
      kind: "checkpoint",
      replacement: {
        key: "runtime-source-state",
        revision: checkpoint.replacementGeneration,
      },
      retainedBytes: 0,
      run: ({ publish, snapshot }) =>
        publish({
          ...snapshot,
          source: {
            digest: checkpoint.replacementDigest,
            generation: checkpoint.replacementGeneration,
            kind: "durable",
          },
        }),
    });
    void completion.then((result) => {
      if (result.kind === "rejected" || result.kind === "failed") {
        void this.#publishReattachment(checkpoint.replacementDigest);
      }
    });
  }

  #publishReattachment(targetDigest: Sha256Digest): Promise<void> {
    return this.#options.session
      .enqueue({
        kind: "lifecycle",
        retainedBytes: 0,
        run: ({ publish, snapshot }) =>
          publish({
            ...snapshot,
            source: reattachingSource(targetDigest),
          }),
      })
      .then(() => undefined);
  }
}

function aborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function isAbortRequested(signal: AbortSignal): boolean {
  return signal.aborted;
}

function reattachingSource(targetDigest: Sha256Digest): {
  readonly kind: "reattaching";
  readonly targetDigest: Sha256Digest;
} {
  return Object.freeze({ kind: "reattaching", targetDigest });
}

function sourceFailureTarget(
  state: MarkdownSourceStateV1,
  fallback: Sha256Digest,
): Sha256Digest {
  return state.kind === "reattaching" ? state.targetDigest : fallback;
}
