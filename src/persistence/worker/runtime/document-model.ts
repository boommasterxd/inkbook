import { VerifiedOutputProofs } from "./verified-output-proofs";
import type { OutputVerificationOptions } from "./verified-output-proofs";
import { ZERO_EXPORT_PHASES, ZERO_UNLOCK_PHASES } from "./runtime-phase-instrumentation";
import { prepareScenePaths } from "./prepare-scene-paths";
import { RuntimeModelError } from "./runtime-model-error";
export { RuntimeModelError } from "./runtime-model-error";
import * as preparedPaths from "./prepared-pressure-path-adoption";
import { parseRuntimeInput } from "./parse-runtime-input";
import type { SafeStaticProof } from "../../serialization/safe-static-proof";
import type { ValidatedSnapshotConsumer } from "../../serialization/validated-snapshot-adoption";
import type {
  InkSnapshotV1,
  SnapshotValidationDerivations,
  StrokeSamplesV1,
} from "../../../domain/schema/public";
import { encodeRuntimeSelection, resolveClipboardPayload } from "../../clipboard/codec";
import { planPaste, resolvePasteTarget } from "../../clipboard/operations";
import type {
  ClipboardCandidates,
  ClipboardResult,
  ClipboardWritePayload,
  DecodedClipboard,
  PasteInvocation,
  PastePlan,
  PasteRepeatState,
} from "../../clipboard/types";
import {
  deriveDocumentIntegrityManifestFromContentDigest,
  IncrementalDocumentSerializer,
} from "../../serialization/public";
import type { DocumentIntegrityManifest } from "../../serialization/document-integrity-manifest";
import { decodeClipboardChunked, encodeRuntimeSelectionChunked } from "./fallback-clipboard-codec";
import {
  copyElementsToRuntime,
  copyParsed,
  copySnapshotToRuntime,
  copySnapshotToRuntimeSliced,
  hasRuntimeStrokeSamples,
  type RuntimeInkSnapshot,
  type RuntimeStrokeSamples,
} from "./runtime-elements";
import type { DocumentExportRequest, ModelSyncRuntimeRequest, RuntimeSliceContext } from "./types";

export type ModelExportResult =
  | { readonly code: string; readonly ok: false; readonly retryable: boolean }
  | {
      readonly hash: string;
      readonly integrityManifest: DocumentIntegrityManifest;
      readonly ok: true;
      readonly output: string | Uint8Array;
      readonly totalBytes: number;
    };

export interface ModelUnlockResult {
  readonly lockedHeight: number;
  readonly outputHash: string;
  readonly requiresCanonicalRewrite: boolean;
  readonly snapshot: InkSnapshotV1;
  readonly sourceVersion: number;
}

interface SlicedPasteOptions {
  readonly commandTimestamp: number;
  readonly context: RuntimeSliceContext;
  readonly createId: () => string;
  readonly invocation: PasteInvocation;
  readonly previousRepeat?: PasteRepeatState;
}

type IncrementalModelRequest =
  | Extract<DocumentExportRequest, { type: "export-incremental" }>
  | Extract<ModelSyncRuntimeRequest, { type: "model-sync-incremental" }>;

const MAX_PREWARM_BYTES = 64 * 1024 * 1024;
const MAX_PREWARM_ELEMENTS = 20_000;

export class DocumentModelRuntime {
  readonly #outputProofs = new VerifiedOutputProofs();
  #pointCopies = new WeakMap<StrokeSamplesV1, RuntimeStrokeSamples>();
  readonly #serializer = new IncrementalDocumentSerializer();
  readonly #now: () => number;
  #lastExportPhases = ZERO_EXPORT_PHASES;
  #lastUnlockPhases = ZERO_UNLOCK_PHASES;
  #prewarmedBytes = 0;
  #prewarmedElementCount = 0;
  #prewarmVisitedElementCount = 0;
  #prewarmCursor = 0;
  #modelRevision: number | null = null;
  #snapshot: InkSnapshotV1 | null = null;

  public constructor(
    now: () => number = () => performance.now(),
    readonly ownsTransferredSamples = false,
  ) {
    this.#now = now;
  }

  public get modelRevision(): number | null {
    return this.#modelRevision;
  }

  public get instrumentation() {
    return {
      ...this.#serializer.instrumentation,
      lastExportPhases: this.#lastExportPhases,
      lastUnlockPhases: this.#lastUnlockPhases,
      prewarmedBytes: this.#prewarmedBytes,
      prewarmedElements: this.#prewarmedElementCount,
      prewarmVisitedElements: this.#prewarmVisitedElementCount,
      retainedCompleteOutputBytes: 0,
    };
  }

  public async unlock(
    input: string | Uint8Array,
    sliceContext?: RuntimeSliceContext,
    onValidatedSnapshot?: ValidatedSnapshotConsumer,
    safeStaticProof?: SafeStaticProof,
  ): Promise<ModelUnlockResult> {
    const started = this.#now();
    let callbackFinished = started;
    let batchAdoptionMs = 0;
    let inputValidationMs = 0;
    let runtimeCopyMs = 0;
    let stagedSnapshot: RuntimeInkSnapshot | null = null;
    let stagedDerivations: SnapshotValidationDerivations | null = null;
    const parsed = await parseRuntimeInput(
      input,
      sliceContext,
      async (snapshot, derivations, signal) => {
        const validationFinished = this.#now();
        inputValidationMs = validationFinished - started;
        stagedSnapshot = await copyParsed(
          snapshot,
          derivations,
          this.#pointCopies,
          sliceContext === undefined ? undefined : { ...sliceContext, signal },
        );
        signal.throwIfAborted();
        const copyFinished = this.#now();
        runtimeCopyMs = copyFinished - validationFinished;
        stagedDerivations = derivations;
        await onValidatedSnapshot?.(stagedSnapshot, derivations, signal);
        callbackFinished = this.#now();
        batchAdoptionMs = callbackFinished - copyFinished;
      },
      "safe",
      this.#serializer.sampleEncodingCache,
      safeStaticProof,
    );
    if (!parsed.ok) throw new RuntimeModelError(parsed.error.code, false);
    sliceContext?.signal.throwIfAborted();
    const parserFinished = this.#now();
    const runtimeSnapshot =
      stagedSnapshot ??
      (sliceContext
        ? await copySnapshotToRuntimeSliced(parsed.value.snapshot, sliceContext, this.#pointCopies)
        : copySnapshotToRuntime(parsed.value.snapshot, this.#pointCopies));
    const modelAdoptionStarted = this.#now();
    this.#resetValidated(runtimeSnapshot, stagedDerivations ?? parsed.value.derivations);
    const finished = this.#now();
    this.#lastUnlockPhases = Object.freeze({
      batchAdoptionMs,
      inputValidationMs,
      modelAdoptionMs: finished - modelAdoptionStarted,
      parserFinalizeMs: parserFinished - callbackFinished,
      runtimeCopyMs,
      totalMs: finished - started,
    });
    const snapshot = this.#snapshot;
    if (snapshot === null) throw new RuntimeModelError("snapshot-invalid", false);
    sliceContext?.signal.throwIfAborted();
    this.#modelRevision = snapshot.revision;
    return {
      lockedHeight: parsed.value.lockedHeight,
      outputHash: parsed.value.hash,
      requiresCanonicalRewrite: parsed.value.requiresCanonicalRewrite,
      snapshot,
      sourceVersion: parsed.value.sourceVersion,
    };
  }

  public async verifyOutput(
    input: string | Uint8Array,
    sliceContext?: RuntimeSliceContext,
    options?: OutputVerificationOptions,
  ): Promise<{ readonly outputHash: string; readonly revision: number } | null> {
    return this.#outputProofs.verify(input, sliceContext, options);
  }

  public initialize(snapshot: InkSnapshotV1): void {
    this.#outputProofs.clear();
    this.#reset(snapshot);
  }

  public clear(): void {
    this.#outputProofs.clear();
    this.#serializer.clear();
    this.#pointCopies = new WeakMap();
    this.#prewarmedBytes = 0;
    this.#prewarmedElementCount = 0;
    this.#prewarmVisitedElementCount = 0;
    this.#prewarmCursor = 0;
    this.#modelRevision = null;
    this.#snapshot = null;
    this.#lastExportPhases = ZERO_EXPORT_PHASES;
    this.#lastUnlockPhases = ZERO_UNLOCK_PHASES;
  }

  public async export(
    request: DocumentExportRequest,
    sliceContext?: RuntimeSliceContext,
  ): Promise<ModelExportResult> {
    const proofEpoch = this.#outputProofs.epoch;
    const started = this.#now();
    try {
      const update =
        request.type === "export-full"
          ? this.#resetForExport(request.snapshot, request.modelRevision)
          : this.#applyIncremental(request, preparedPaths.preparedPressurePathIds(request));
      const modelUpdated = this.#now();
      if (!update.ok) return failure(update.error.code, true);
      await preparedPaths.acceptPreparedPressurePaths(request, this.#serializer, sliceContext);
      const serialized = await this.#serializeRuntimeChunked(sliceContext);
      if (!serialized.ok) return failure(serialized.error.code, true);
      const integrityManifest = deriveDocumentIntegrityManifestFromContentDigest(
        serialized.value.snapshot,
        serialized.value.snapshotHash,
      );
      const finished = this.#now();
      this.#lastExportPhases = Object.freeze({
        modelUpdateMs: modelUpdated - started,
        serializationMs: finished - modelUpdated,
        totalMs: finished - started,
      });
      sliceContext?.signal.throwIfAborted();
      this.#outputProofs.acceptExport(
        serialized.value.hash,
        serialized.value.snapshot.revision,
        proofEpoch,
      );
      this.#snapshot = serialized.value.snapshot;
      this.#modelRevision = serialized.value.snapshot.revision;
      this.#resetPrewarmState();
      if (this.#serializer.hasCompleteFragmentCache()) {
        this.#prewarmCursor = this.#serializer.currentElementCount();
      }
      return {
        hash: serialized.value.hash,
        integrityManifest,
        ok: true,
        output: serialized.value.svg,
        totalBytes: serialized.value.totalBytes,
      };
    } catch (error) {
      return failure(error instanceof RuntimeModelError ? error.code : "runtime-failure", false);
    }
  }

  public synchronize(request: ModelSyncRuntimeRequest): void {
    const update =
      request.type === "model-sync-full"
        ? this.#resetForSynchronization(request.snapshot, request.modelRevision)
        : this.#applyIncremental(request);
    if (!update.ok) throw new RuntimeModelError(update.error.code, true);
    if (this.#serializer.currentRevision() === null) {
      throw new RuntimeModelError("snapshot-invalid", false);
    }
    this.#snapshot = null;
    this.#modelRevision = request.modelRevision;
    this.#prewarmedBytes = 0;
    this.#prewarmedElementCount = 0;
    this.#prewarmVisitedElementCount = 0;
    this.#prewarmCursor = 0;
  }

  public async prepareScenePaths(
    request: import("./types").PrepareScenePathsRuntimeRequest,
    context: { readonly signal: AbortSignal; checkpoint(): Promise<void> | undefined },
    progress?: import("./prepare-scene-paths").ScenePathProgress,
  ): Promise<import("./types").PreparedScenePathsRuntimeSuccess["paths"]> {
    return prepareScenePaths(
      request,
      context,
      this.#serializer,
      () => {
        this.#validatedPasteState(request.basisRevision);
      },
      progress,
    );
  }

  public encodeClipboard(
    basisRevision: number,
    selectedIds: readonly string[],
  ): ClipboardResult<ClipboardWritePayload> {
    const snapshot = this.#atRevision(basisRevision);
    const encoded = encodeRuntimeSelection(snapshot.elements, new Set(selectedIds));
    return encoded.ok
      ? {
          ok: true,
          value: {
            byteLength: encoded.value.byteLength,
            customText: encoded.value.customText,
            plainText: encoded.value.plainText,
          },
        }
      : encoded;
  }

  public async encodeClipboardSliced(
    basisRevision: number,
    selectedIds: readonly string[],
    context: RuntimeSliceContext,
  ): Promise<ClipboardResult<ClipboardWritePayload>> {
    const snapshot = this.#atRevision(basisRevision);
    return encodeRuntimeSelectionChunked(snapshot.elements, selectedIds, context);
  }

  public decodeClipboard(
    basisRevision: number,
    candidates: ClipboardCandidates,
  ): ClipboardResult<DecodedClipboard> {
    this.#atRevision(basisRevision);
    return resolveClipboardPayload(candidates);
  }

  public async decodeClipboardSliced(
    basisRevision: number,
    candidates: ClipboardCandidates,
    context: RuntimeSliceContext,
  ): Promise<ClipboardResult<DecodedClipboard>> {
    this.#atRevision(basisRevision);
    return decodeClipboardChunked(candidates, context);
  }

  public planClipboardPaste(
    basisRevision: number,
    candidates: ClipboardCandidates,
    invocation: PasteInvocation,
    commandTimestamp: number,
    createId: () => string,
    previousRepeat?: PasteRepeatState,
  ): ClipboardResult<PastePlan> {
    const { page, facts } = this.#validatedPasteState(basisRevision);
    const decoded = resolveClipboardPayload(candidates);
    if (!decoded.ok) return decoded;
    return planPaste({
      commandTimestamp,
      createId,
      decoded: decoded.value,
      page,
      ...(previousRepeat === undefined ? {} : { previousRepeat }),
      target: resolvePasteTarget(invocation),
      validatedModel: { facts, hasExistingId: (id) => this.#serializer.hasElement(id) },
    });
  }

  public async planClipboardPasteSliced(
    basisRevision: number,
    candidates: ClipboardCandidates,
    options: SlicedPasteOptions,
  ): Promise<ClipboardResult<PastePlan>> {
    this.#validatedPasteState(basisRevision);
    const decoded = await decodeClipboardChunked(candidates, options.context);
    if (!decoded.ok) return decoded;
    await options.context.checkpoint();
    const { page, facts } = this.#validatedPasteState(basisRevision);
    return planPaste({
      commandTimestamp: options.commandTimestamp,
      createId: options.createId,
      decoded: decoded.value,
      page,
      ...(options.previousRepeat === undefined ? {} : { previousRepeat: options.previousRepeat }),
      target: resolvePasteTarget(options.invocation),
      validatedModel: { facts, hasExistingId: (id) => this.#serializer.hasElement(id) },
    });
  }

  public async prewarmOne(context: RuntimeSliceContext): Promise<boolean> {
    const elementCount = this.#serializer.currentElementCount();
    if (
      this.#serializer.currentRevision() === null ||
      this.#serializer.currentRevision() !== this.#modelRevision ||
      this.#prewarmCursor >= elementCount ||
      this.#prewarmVisitedElementCount >= MAX_PREWARM_ELEMENTS ||
      this.#prewarmedBytes >= MAX_PREWARM_BYTES
    ) {
      return false;
    }
    context.signal.throwIfAborted();
    const index = this.#prewarmCursor;
    this.#prewarmCursor += 1;
    this.#prewarmVisitedElementCount += 1;
    const cachedBytes = this.#serializer.prewarmElementAt(
      index,
      MAX_PREWARM_BYTES - this.#prewarmedBytes,
    );
    if (cachedBytes !== null) {
      this.#prewarmedElementCount += 1;
      this.#prewarmedBytes += cachedBytes;
    }
    await context.checkpoint();
    return this.#prewarmCursor < elementCount;
  }

  #resetForExport(snapshot: InkSnapshotV1, modelRevision: number) {
    if (snapshot.revision !== modelRevision)
      throw new RuntimeModelError("revision-mismatch", false);
    // Unowned samples are privately copied; transfers and immutable Store samples may be borrowed.
    return this.#serializer.resetRuntime(this.#runtimeSnapshot(snapshot), true);
  }

  #applyIncremental(request: IncrementalModelRequest, deferredFragmentIds?: ReadonlySet<string>) {
    const ownsSamples = this.ownsTransferredSamples;
    const changedElements =
      request.changedElements === undefined
        ? undefined
        : copyElementsToRuntime(request.changedElements, this.#pointCopies, ownsSamples);
    return this.#serializer.applyDelta(
      {
        ...request,
        ...(changedElements === undefined ? {} : { changedElements }),
      },
      deferredFragmentIds,
      true,
    );
  }

  #resetForSynchronization(snapshot: InkSnapshotV1, modelRevision: number) {
    if (snapshot.revision !== modelRevision) {
      throw new RuntimeModelError("revision-mismatch", false);
    }
    return this.#serializer.resetRuntime(this.#runtimeSnapshot(snapshot), true);
  }

  #reset(snapshot: InkSnapshotV1): void {
    this.#adoptResetResult(this.#serializer.resetRuntime(this.#runtimeSnapshot(snapshot), true));
    this.#modelRevision = this.#snapshot!.revision;
  }

  #resetValidated(snapshot: InkSnapshotV1, derivations: SnapshotValidationDerivations): void {
    this.#adoptResetResult(this.#serializer.resetValidatedRuntime(snapshot, derivations, true));
  }

  #adoptResetResult(result: ReturnType<IncrementalDocumentSerializer["resetRuntime"]>): void {
    if (!result.ok) throw new RuntimeModelError(result.error.code, false);
    this.#snapshot = this.#serializer.currentSnapshot();
    if (this.#snapshot === null) throw new RuntimeModelError("snapshot-invalid", false);
    this.#resetPrewarmState();
  }

  #resetPrewarmState(): void {
    this.#prewarmedBytes = 0;
    this.#prewarmedElementCount = 0;
    this.#prewarmVisitedElementCount = 0;
    this.#prewarmCursor = 0;
  }

  #serializeRuntimeChunked(sliceContext?: RuntimeSliceContext) {
    return this.#serializer.serializeRuntimeChunked({
      ...(sliceContext === undefined
        ? {}
        : { checkpoint: sliceContext.checkpoint, signal: sliceContext.signal }),
      ...(sliceContext?.workProfile === undefined
        ? {}
        : { sliceByteLimit: sliceContext.workProfile.outputByteLimit }),
    });
  }

  #runtimeSnapshot(snapshot: InkSnapshotV1): RuntimeInkSnapshot {
    return this.ownsTransferredSamples && hasRuntimeStrokeSamples(snapshot)
      ? (snapshot as RuntimeInkSnapshot)
      : copySnapshotToRuntime(snapshot, this.#pointCopies, undefined, this.ownsTransferredSamples);
  }
  #atRevision(revision: number): InkSnapshotV1 {
    if (this.#modelRevision !== revision || this.#serializer.currentRevision() !== revision) {
      throw new RuntimeModelError("basis-revision-mismatch", true);
    }
    const snapshot = this.#snapshot ?? this.#serializer.currentSnapshot();
    if (snapshot === null || snapshot.revision !== revision)
      throw new RuntimeModelError("snapshot-invalid", false);
    this.#snapshot = snapshot;
    return snapshot;
  }
  #validatedPasteState(revision: number) {
    if (this.#modelRevision !== revision || this.#serializer.currentRevision() !== revision) {
      throw new RuntimeModelError("basis-revision-mismatch", true);
    }
    const page = this.#serializer.currentPage();
    const facts = this.#serializer.currentAggregateFacts();
    if (page === null || facts === null) throw new RuntimeModelError("snapshot-invalid", false);
    return { facts, page };
  }
}

function failure(code: string, retryable: boolean): ModelExportResult {
  return { code, ok: false, retryable };
}
