import { commandFailure, commandSuccess } from "../note-session/results";
import type {
  CommandErrorCodeV1,
  CommandResultV1,
  HostTransactionSequence,
  SessionOrder,
  Sha256Digest,
  SourceCheckpointId,
  SourceGeneration,
  ViewId,
} from "../note-session/types";
import type { RecoveryStore } from "../recovery/port";
import type { SidecarBaseIdentityV1 } from "../recovery/base";
import type {
  AdmittedSourceTransitionV1,
  ForcedSourceBarrierV1,
  PendingSourceCheckpointV1,
  SourceCheckpointSchedulerV1,
} from "./checkpoints";
import { SourceCheckpointPipelineV1 } from "./checkpoint-pipeline";
import {
  recognizeSourceDuplicate,
  sourceViewSequenceState,
} from "./coordinator-admission";
import {
  appendSourceMapGraphNode,
  createCompactedSourceMapNode,
  createSourceMapCompositionRequest,
  createSourceMapCompositionRequestFromSegments,
  createSourceMapGraphRoot,
  sourceCoordinationRetainedBytes,
  sourceMapGraphNeedsCompaction,
  type SourceMapGraphNodeV1,
} from "./map-graph";
import { identifySourceOffsetMap } from "./offset-map";
import {
  createSourceSnapshot,
  digestMarkdownSnapshot,
  SOURCE_COORDINATION_LIMITS_V1,
} from "./limits";
import { SourceDigestWorkOwnerV1 } from "./source-digest";
import type {
  MarkdownSourceStateV1,
  MarkdownSourceTransitionV1,
  SourceAdmissionV1,
  SourceCheckpointOperationV1,
  SourceOffsetMapIdentityV1,
  SourceSnapshotV1,
  StreamingSha256PortV1,
} from "./types";
import {
  SourceMapWorkOwnerV1,
  type SourceDigestWorkPortV1,
  type SourceMapWorkPortV1,
} from "./work-ports";

export interface MarkdownSourceCoordinatorOptionsV1 {
  readonly createCheckpointId: () => SourceCheckpointId;
  readonly digestPort: StreamingSha256PortV1;
  readonly initialDigest: Sha256Digest;
  readonly initialGeneration: SourceGeneration;
  readonly initialMarkdown: string;
  readonly nextSessionOrder: () => SessionOrder;
  readonly onDurableCheckpoint?: (
    checkpoint: SourceCheckpointOperationV1,
    snapshot: SourceSnapshotV1,
  ) => void;
  readonly onSaveGeneration?: (
    generation: SourceGeneration,
    digest: Sha256Digest,
  ) => void;
  readonly onSourceStateChange?: (state: MarkdownSourceStateV1) => void;
  readonly readBase: () => SidecarBaseIdentityV1;
  readonly recoveryStore: Pick<RecoveryStore, "appendSourceCheckpoint">;
  readonly scheduler: SourceCheckpointSchedulerV1;
  readonly sourceDigestWorkPort: SourceDigestWorkPortV1;
  readonly sourceMapWorkPort: SourceMapWorkPortV1;
}

export async function createMarkdownSourceCoordinator(
  options: MarkdownSourceCoordinatorOptionsV1,
): Promise<CommandResultV1<MarkdownSourceCoordinatorV1>> {
  const snapshot = createSourceSnapshot(options.initialMarkdown);
  if (!snapshot.ok) return snapshot;
  const digest = await digestMarkdownSnapshot(
    options.digestPort,
    snapshot.value,
    options.sourceDigestWorkPort,
  );
  if (!digest.ok) return digest;
  if (digest.value !== options.initialDigest) {
    return commandFailure("stale-source");
  }
  const root = createSourceMapGraphRoot(
    options.initialGeneration,
    digest.value,
    snapshot.value,
  );
  if (!root.ok) return root;
  return commandSuccess(new MarkdownSourceCoordinatorV1(options, root.value));
}

export class MarkdownSourceCoordinatorV1 {
  readonly #options: MarkdownSourceCoordinatorOptionsV1;
  readonly #viewSequences = new Map<ViewId, HostTransactionSequence>();
  readonly #graphRoot: SourceMapGraphNodeV1;
  readonly #sourceMapWork = new SourceMapWorkOwnerV1();
  readonly #sourceDigestWork: SourceDigestWorkOwnerV1;
  readonly #checkpoints: SourceCheckpointPipelineV1;
  #disposed = false;
  #lastTransition: AdmittedSourceTransitionV1 | null = null;
  #mismatchDigest: Sha256Digest | null = null;
  #sourceFailure: CommandErrorCodeV1 | null = null;
  #transient: SourceMapGraphNodeV1;

  constructor(
    options: MarkdownSourceCoordinatorOptionsV1,
    root: SourceMapGraphNodeV1,
  ) {
    this.#options = options;
    this.#graphRoot = root;
    this.#transient = root;
    this.#sourceDigestWork = new SourceDigestWorkOwnerV1(
      options.digestPort,
      options.sourceDigestWorkPort,
    );
    this.#checkpoints = new SourceCheckpointPipelineV1({
      createCheckpointId: options.createCheckpointId,
      initialSource: root,
      nextSessionOrder: options.nextSessionOrder,
      onChanged: (): void => this.#notifySourceState(),
      ...(options.onDurableCheckpoint === undefined
        ? {}
        : { onDurableCheckpoint: options.onDurableCheckpoint }),
      ...(options.onSaveGeneration === undefined
        ? {}
        : { onSaveGeneration: options.onSaveGeneration }),
      readBase: options.readBase,
      recoveryStore: options.recoveryStore,
      scheduler: options.scheduler,
    });
  }

  get currentSource(): SourceMapGraphNodeV1 {
    return this.#transient;
  }

  get durableSource(): SourceMapGraphNodeV1 {
    return this.#checkpoints.durable;
  }

  get mismatchDigest(): Sha256Digest | null {
    return this.#mismatchDigest;
  }

  get retainedSourceBytes(): number {
    return this.#calculateRetainedBytes(
      this.#transient,
      this.#checkpoints.latest,
      this.#lastTransition,
    );
  }

  get sourceState(): MarkdownSourceStateV1 {
    if (this.#mismatchDigest !== null) {
      return Object.freeze({
        failure: this.#sourceFailure ?? "stale-source",
        kind: "reattaching",
        targetDigest: this.#mismatchDigest,
      });
    }
    if (
      this.#transient !== this.#checkpoints.durable ||
      this.#checkpoints.active !== null ||
      this.#checkpoints.latest !== null ||
      this.#checkpoints.failure !== null
    ) {
      return Object.freeze({
        durableGeneration: this.#checkpoints.durable.generation,
        failure: this.#checkpoints.failure,
        generation: this.#transient.generation,
        kind: "checkpoint-pending",
      });
    }
    return Object.freeze({
      digest: this.#checkpoints.durable.digest,
      generation: this.#checkpoints.durable.generation,
      kind: "durable",
    });
  }

  admit(
    request: MarkdownSourceTransitionV1,
  ): Promise<CommandResultV1<SourceAdmissionV1>> {
    return this.#admit(request);
  }

  beginForcedBarrier(): ForcedSourceBarrierV1 {
    return this.#checkpoints.beginForcedBarrier(this.#transient.generation);
  }

  retryCheckpoint(): CommandResultV1<void> {
    return this.#checkpoints.retry();
  }

  detachView(viewId: ViewId): void {
    this.#viewSequences.delete(viewId);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#checkpoints.dispose();
    this.#lastTransition = null;
    this.#sourceMapWork.dispose();
    this.#sourceDigestWork.dispose();
    this.#viewSequences.clear();
  }

  async #admit(
    request: MarkdownSourceTransitionV1,
  ): Promise<CommandResultV1<SourceAdmissionV1>> {
    if (this.#isDisposed()) return commandFailure("disposed");
    const expectedSource = this.#transient;
    const sequenceState = sourceViewSequenceState(this.#viewSequences, request);
    if (sequenceState === null) {
      return commandFailure("stale-source");
    }
    const snapshot = createSourceSnapshot(request.replacementMarkdown);
    if (!snapshot.ok) return snapshot;
    const digest = await this.#sourceDigestWork.digest(snapshot.value);
    if (!digest.ok) return digest;
    if (this.#isDisposed()) return commandFailure("disposed");
    if (this.#transient !== expectedSource) {
      return this.#failSourceWork("stale-source", digest.value);
    }
    const prior = this.#lastTransition;
    const replaysLast =
      prior !== null &&
      request.priorGeneration === prior.priorGeneration &&
      request.priorDigest === prior.priorDigest;
    if (
      !replaysLast &&
      (request.priorGeneration !== this.#transient.generation ||
        request.priorDigest !== this.#transient.digest)
    ) {
      this.#viewSequences.set(request.viewId, request.hostTransactionSequence);
      return this.#failMismatch(digest.value);
    }
    const mapPriorLength = replaysLast
      ? prior.mapIdentity.priorUtf16Length
      : this.#transient.snapshot.utf16Length;
    const mapIdentity = await identifySourceOffsetMap(
      this.#options.digestPort,
      request.offsetMap,
      mapPriorLength,
      snapshot.value.utf16Length,
    );
    if (!mapIdentity.ok) return mapIdentity;
    if (
      request.offsetMapDigest !== undefined &&
      request.offsetMapDigest !== mapIdentity.value.digest
    ) {
      this.#viewSequences.set(request.viewId, request.hostTransactionSequence);
      return this.#failMismatch(digest.value);
    }
    const duplicate = recognizeSourceDuplicate(
      this.#lastTransition,
      this.#transient,
      request,
      digest.value,
      mapIdentity.value.digest,
    );
    if (duplicate !== null) {
      this.#viewSequences.set(request.viewId, request.hostTransactionSequence);
      return commandSuccess(duplicate);
    }
    if (replaysLast || sequenceState === "retry")
      return this.#failMismatch(digest.value);
    const admitted = await this.#admitNewTransition(
      request,
      snapshot.value,
      digest.value,
      mapIdentity.value,
    );
    if (admitted.ok) {
      this.#viewSequences.set(request.viewId, request.hostTransactionSequence);
    }
    return admitted;
  }

  async #admitNewTransition(
    request: MarkdownSourceTransitionV1,
    snapshot: SourceSnapshotV1,
    digest: Sha256Digest,
    mapIdentity: SourceOffsetMapIdentityV1,
  ): Promise<CommandResultV1<SourceAdmissionV1>> {
    if (this.#transient.generation >= Number.MAX_SAFE_INTEGER) {
      return commandFailure("resource-limit");
    }
    const parent = await this.#prepareAppendParent(snapshot, mapIdentity);
    if (!parent.ok) return this.#failSourceWork(parent.code, digest);
    const generation = (this.#transient.generation + 1) as SourceGeneration;
    const node = appendSourceMapGraphNode(
      parent.value,
      generation,
      digest,
      snapshot,
      mapIdentity,
    );
    if (!node.ok) return node;
    const pending = await this.#extendPending(node.value, mapIdentity);
    if (!pending.ok) return this.#failSourceWork(pending.code, digest);
    if (
      this.#calculateRetainedBytes(node.value, pending.value, null) >
      SOURCE_COORDINATION_LIMITS_V1.maxRetainedSourceBytes
    ) {
      return this.#failSourceWork("resource-limit", digest);
    }
    this.#transient = node.value;
    this.#checkpoints.setLatest(pending.value);
    this.#lastTransition = Object.freeze({
      mapDigest: mapIdentity.digest,
      mapIdentity,
      node: node.value,
      priorDigest: request.priorDigest,
      priorGeneration: request.priorGeneration,
    });
    this.#mismatchDigest = null;
    this.#sourceFailure = null;
    this.#notifySourceState();
    return commandSuccess(
      Object.freeze({
        digest,
        generation,
        kind: "admitted",
        mapDigest: mapIdentity.digest,
        snapshot,
      }),
    );
  }

  async #extendPending(
    replacement: SourceMapGraphNodeV1,
    transition: SourceOffsetMapIdentityV1,
  ): Promise<CommandResultV1<PendingSourceCheckpointV1>> {
    if (this.#checkpoints.latest === null) {
      return commandSuccess(
        Object.freeze({
          mapIdentity: transition,
          prior: this.#transient,
          replacement,
        }),
      );
    }
    const latest = this.#checkpoints.latest;
    const request = createSourceMapCompositionRequestFromSegments([
      latest.mapIdentity,
      transition,
    ]);
    if (!request.ok) return request;
    const composed = await this.#sourceMapWork.run(
      this.#options.sourceMapWorkPort,
      request.value,
    );
    if (!composed.ok) return composed;
    if (this.#isDisposed()) return commandFailure("disposed");
    if (this.#checkpoints.latest !== latest)
      return commandFailure("stale-source");
    const identity = await identifySourceOffsetMap(
      this.#options.digestPort,
      composed.value,
      latest.prior.snapshot.utf16Length,
      replacement.snapshot.utf16Length,
    );
    if (!identity.ok) return identity;
    if (this.#isDisposed()) return commandFailure("disposed");
    if (this.#checkpoints.latest !== latest)
      return commandFailure("stale-source");
    return commandSuccess(
      Object.freeze({
        mapIdentity: identity.value,
        prior: latest.prior,
        replacement,
      }),
    );
  }

  async #prepareAppendParent(
    snapshot: SourceSnapshotV1,
    mapIdentity: SourceOffsetMapIdentityV1,
  ): Promise<CommandResultV1<SourceMapGraphNodeV1>> {
    const expected = this.#transient;
    const projectedBytes =
      this.retainedSourceBytes +
      snapshot.retainedBytes +
      mapIdentity.encodedBytes;
    if (!sourceMapGraphNeedsCompaction(expected, projectedBytes)) {
      return commandSuccess(expected);
    }
    if (expected === this.#graphRoot) return commandFailure("resource-limit");
    const request = createSourceMapCompositionRequest(
      this.#graphRoot,
      expected,
    );
    if (!request.ok) return request;
    const composed = await this.#sourceMapWork.run(
      this.#options.sourceMapWorkPort,
      request.value,
    );
    if (!composed.ok) return composed;
    if (this.#isDisposed()) return commandFailure("disposed");
    if (this.#transient !== expected) return commandFailure("stale-source");
    const identity = await identifySourceOffsetMap(
      this.#options.digestPort,
      composed.value,
      this.#graphRoot.snapshot.utf16Length,
      expected.snapshot.utf16Length,
    );
    if (!identity.ok) return identity;
    if (this.#isDisposed()) return commandFailure("disposed");
    if (this.#transient !== expected) return commandFailure("stale-source");
    return createCompactedSourceMapNode(
      this.#graphRoot,
      expected,
      identity.value,
    );
  }

  #calculateRetainedBytes(
    transient: SourceMapGraphNodeV1,
    latest: PendingSourceCheckpointV1 | null,
    lastTransition: AdmittedSourceTransitionV1 | null,
  ): number {
    const ownership = this.#checkpoints.retainedOwnership;
    const roots = [
      this.#graphRoot,
      this.#checkpoints.durable,
      transient,
      ...ownership.roots,
    ];
    const maps: SourceOffsetMapIdentityV1[] = [...ownership.maps];
    if (latest !== null && latest !== this.#checkpoints.latest) {
      roots.push(latest.prior, latest.replacement);
      maps.push(latest.mapIdentity);
    }
    if (lastTransition !== null) {
      roots.push(lastTransition.node);
      maps.push(lastTransition.mapIdentity);
    }
    return sourceCoordinationRetainedBytes(roots, maps);
  }

  #failSourceWork<T>(
    code: CommandErrorCodeV1,
    digest: Sha256Digest,
  ): CommandResultV1<T> {
    this.#sourceFailure = code;
    this.#mismatchDigest = digest;
    this.#checkpoints.block(code);
    this.#notifySourceState();
    return commandFailure(code);
  }

  #isDisposed(): boolean {
    return this.#disposed;
  }

  #failMismatch<T>(digest: Sha256Digest): CommandResultV1<T> {
    return this.#failSourceWork("stale-source", digest);
  }

  #notifySourceState(): void {
    try {
      this.#options.onSourceStateChange?.(this.sourceState);
    } catch {
      // The immutable getter remains authoritative when an observer fails.
    }
  }
}
