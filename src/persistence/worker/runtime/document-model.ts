import type { InkSnapshotV1, SnapshotValidationDerivations } from "../../../domain/schema/public";
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
  ChunkedInkbookInputParser,
  deriveDocumentIntegrityManifest,
  deriveDocumentIntegrityManifestFromContentDigest,
  IncrementalDocumentSerializer,
} from "../../serialization/public";
import type { DocumentIntegrityManifest } from "../../serialization/document-integrity-manifest";
import { decodeClipboardChunked, encodeRuntimeSelectionChunked } from "./fallback-clipboard-codec";
import {
  copyElementsToRuntime,
  copySnapshotToRuntime,
  hasRuntimeStrokeSamples,
  type RuntimeInkSnapshot,
} from "./runtime-elements";
import type { DocumentExportRequest, ModelSyncRuntimeRequest, RuntimeSliceContext } from "./types";

export type ModelExportResult =
  | { readonly code: string; readonly ok: false; readonly retryable: boolean }
  | {
      readonly hash: string;
      readonly integrityManifest: DocumentIntegrityManifest;
      readonly ok: true;
      readonly output: string | Uint8Array;
    };

export interface ModelUnlockResult {
  readonly integrityManifest: DocumentIntegrityManifest;
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

interface UnlockPhaseDurations {
  readonly batchAdoptionMs: number;
  readonly inputValidationMs: number;
  readonly modelAdoptionMs: number;
  readonly parserFinalizeMs: number;
  readonly runtimeCopyMs: number;
  readonly totalMs: number;
}

interface ExportPhaseDurations {
  readonly modelUpdateMs: number;
  readonly serializationMs: number;
  readonly totalMs: number;
}

const ZERO_UNLOCK_PHASES: UnlockPhaseDurations = Object.freeze({
  batchAdoptionMs: 0,
  inputValidationMs: 0,
  modelAdoptionMs: 0,
  parserFinalizeMs: 0,
  runtimeCopyMs: 0,
  totalMs: 0,
});

const ZERO_EXPORT_PHASES: ExportPhaseDurations = Object.freeze({
  modelUpdateMs: 0,
  serializationMs: 0,
  totalMs: 0,
});

export class DocumentModelRuntime {
  readonly #serializer = new IncrementalDocumentSerializer();
  readonly #now: () => number;
  #lastExportPhases = ZERO_EXPORT_PHASES;
  #lastUnlockPhases = ZERO_UNLOCK_PHASES;
  #prewarmedBytes = 0;
  #prewarmedElementCount = 0;
  #prewarmVisitedElementCount = 0;
  #prewarmCursor = 0;
  #snapshot: InkSnapshotV1 | null = null;

  public constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  public get modelRevision(): number | null {
    return this.#snapshot?.revision ?? null;
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
    onValidatedSnapshot?: (
      snapshot: InkSnapshotV1,
      derivations: SnapshotValidationDerivations,
    ) => Promise<void> | void,
  ): Promise<ModelUnlockResult> {
    const started = this.#now();
    let callbackFinished = started;
    let batchAdoptionMs = 0;
    let inputValidationMs = 0;
    let runtimeCopyMs = 0;
    let stagedRuntimeSnapshot: RuntimeInkSnapshot | null = null;
    let stagedDerivations: SnapshotValidationDerivations | null = null;
    const parsed = await parseRuntimeInput(input, sliceContext, async (snapshot, derivations) => {
      const validationFinished = this.#now();
      inputValidationMs = validationFinished - started;
      stagedRuntimeSnapshot = copySnapshotToRuntime(snapshot);
      const copyFinished = this.#now();
      runtimeCopyMs = copyFinished - validationFinished;
      stagedDerivations = derivations;
      await onValidatedSnapshot?.(stagedRuntimeSnapshot, derivations);
      callbackFinished = this.#now();
      batchAdoptionMs = callbackFinished - copyFinished;
    });
    if (!parsed.ok) throw new RuntimeModelError(parsed.error.code, false);
    const parserFinished = this.#now();
    const runtimeSnapshot = stagedRuntimeSnapshot ?? copySnapshotToRuntime(parsed.value.snapshot);
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
    return {
      integrityManifest: deriveDocumentIntegrityManifest(snapshot),
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
  ): Promise<{ readonly outputHash: string; readonly revision: number } | null> {
    const parsed = await parseRuntimeInput(input, sliceContext, undefined, false);
    return parsed.ok
      ? { outputHash: parsed.value.hash, revision: parsed.value.snapshot.revision }
      : null;
  }

  public initialize(snapshot: InkSnapshotV1): void {
    this.#reset(snapshot);
  }

  public clear(): void {
    this.#serializer.clear();
    this.#prewarmedBytes = 0;
    this.#prewarmedElementCount = 0;
    this.#prewarmVisitedElementCount = 0;
    this.#prewarmCursor = 0;
    this.#snapshot = null;
    this.#lastExportPhases = ZERO_EXPORT_PHASES;
    this.#lastUnlockPhases = ZERO_UNLOCK_PHASES;
  }

  public async export(
    request: DocumentExportRequest,
    sliceContext?: RuntimeSliceContext,
  ): Promise<ModelExportResult> {
    const started = this.#now();
    try {
      const update =
        request.type === "export-full"
          ? this.#resetForExport(request.snapshot, request.modelRevision)
          : this.#applyIncremental(request);
      const modelUpdated = this.#now();
      if (!update.ok) return failure(update.error.code, true);
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
      this.#snapshot = serialized.value.snapshot;
      this.#resetPrewarmState();
      return {
        hash: serialized.value.hash,
        integrityManifest,
        ok: true,
        output: serialized.value.svg,
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
    const snapshot = this.#serializer.currentSnapshot();
    if (snapshot === null) throw new RuntimeModelError("snapshot-invalid", false);
    this.#snapshot = snapshot;
    this.#prewarmedBytes = 0;
    this.#prewarmedElementCount = 0;
    this.#prewarmVisitedElementCount = 0;
    this.#prewarmCursor = 0;
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
    const snapshot = this.#atRevision(basisRevision);
    const decoded = resolveClipboardPayload(candidates);
    if (!decoded.ok) return decoded;
    return planPaste({
      commandTimestamp,
      createId,
      decoded: decoded.value,
      existingElements: snapshot.elements,
      page: snapshot.page,
      ...(previousRepeat === undefined ? {} : { previousRepeat }),
      target: resolvePasteTarget(invocation),
    });
  }

  public async planClipboardPasteSliced(
    basisRevision: number,
    candidates: ClipboardCandidates,
    options: SlicedPasteOptions,
  ): Promise<ClipboardResult<PastePlan>> {
    const snapshot = this.#atRevision(basisRevision);
    const decoded = await decodeClipboardChunked(candidates, options.context);
    if (!decoded.ok) return decoded;
    await options.context.checkpoint();
    return planPaste({
      commandTimestamp: options.commandTimestamp,
      createId: options.createId,
      decoded: decoded.value,
      existingElements: snapshot.elements,
      page: snapshot.page,
      ...(options.previousRepeat === undefined ? {} : { previousRepeat: options.previousRepeat }),
      target: resolvePasteTarget(options.invocation),
    });
  }

  public async prewarmOne(context: RuntimeSliceContext): Promise<boolean> {
    const snapshot = this.#snapshot;
    if (
      snapshot === null ||
      this.#prewarmCursor >= snapshot.elements.length ||
      this.#prewarmVisitedElementCount >= MAX_PREWARM_ELEMENTS ||
      this.#prewarmedBytes >= MAX_PREWARM_BYTES
    ) {
      return false;
    }
    context.signal.throwIfAborted();
    const element = snapshot.elements[this.#prewarmCursor]!;
    this.#prewarmCursor += 1;
    this.#prewarmVisitedElementCount += 1;
    const cachedBytes = this.#serializer.prewarmElement(
      element.id,
      MAX_PREWARM_BYTES - this.#prewarmedBytes,
    );
    if (cachedBytes !== null) {
      this.#prewarmedElementCount += 1;
      this.#prewarmedBytes += cachedBytes;
    }
    await context.checkpoint();
    return this.#prewarmCursor < snapshot.elements.length;
  }

  #resetForExport(snapshot: InkSnapshotV1, modelRevision: number) {
    if (snapshot.revision !== modelRevision) {
      throw new RuntimeModelError("revision-mismatch", false);
    }
    return this.#serializer.resetRuntime(this.#runtimeSnapshot(snapshot));
  }

  #applyIncremental(request: IncrementalModelRequest) {
    return this.#serializer.applyDelta({
      ...request,
      ...(request.changedElements === undefined
        ? {}
        : { changedElements: copyElementsToRuntime(request.changedElements) }),
    });
  }

  #resetForSynchronization(snapshot: InkSnapshotV1, modelRevision: number) {
    if (snapshot.revision !== modelRevision) {
      throw new RuntimeModelError("revision-mismatch", false);
    }
    return this.#serializer.resetRuntime(this.#runtimeSnapshot(snapshot));
  }

  #reset(snapshot: InkSnapshotV1): void {
    this.#adoptResetResult(this.#serializer.resetRuntime(this.#runtimeSnapshot(snapshot)));
  }

  #resetValidated(snapshot: InkSnapshotV1, derivations: SnapshotValidationDerivations): void {
    this.#adoptResetResult(this.#serializer.resetValidatedRuntime(snapshot, derivations));
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
    return this.#serializer.serializeRuntimeChunked(
      sliceContext === undefined
        ? {}
        : {
            checkpoint: sliceContext.checkpoint,
            ...(sliceContext.workProfile === undefined
              ? {}
              : { sliceByteLimit: sliceContext.workProfile.outputByteLimit }),
            signal: sliceContext.signal,
          },
    );
  }

  #runtimeSnapshot(snapshot: InkSnapshotV1): RuntimeInkSnapshot {
    return hasRuntimeStrokeSamples(snapshot)
      ? (snapshot as RuntimeInkSnapshot)
      : copySnapshotToRuntime(snapshot);
  }

  #atRevision(revision: number): InkSnapshotV1 {
    const snapshot = this.#snapshot;
    if (snapshot === null || snapshot.revision !== revision) {
      throw new RuntimeModelError("basis-revision-mismatch", true);
    }
    return snapshot;
  }
}

export class RuntimeModelError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(code);
    this.name = "RuntimeModelError";
  }
}

function failure(code: string, retryable: boolean): ModelExportResult {
  return { code, ok: false, retryable };
}

async function parseRuntimeInput(
  input: string | Uint8Array,
  context?: RuntimeSliceContext,
  onValidatedSnapshot?: (
    snapshot: InkSnapshotV1,
    derivations: SnapshotValidationDerivations,
  ) => Promise<void> | void,
  allowLegacyPressureCaps = true,
) {
  const inputSliceBytes = context?.workProfile?.inputByteLimit ?? 256 * 1024;
  const inputWriteChunk = context?.workProfile?.inputByteLimit ?? 16 * 1024;
  const parser = new ChunkedInkbookInputParser({
    allowLegacyPressureCaps,
    ...(context === undefined ? {} : { checkpoint: context.checkpoint, signal: context.signal }),
    inputSliceBytes,
    ...(onValidatedSnapshot === undefined ? {} : { onValidatedSnapshot }),
  });
  if (typeof input === "string") await writeStringInput(parser, input, inputWriteChunk);
  else await writeByteInput(parser, input, inputWriteChunk);
  return parser.finish();
}

async function writeByteInput(
  parser: ChunkedInkbookInputParser,
  input: Uint8Array,
  chunkBytes: number,
): Promise<void> {
  for (let offset = 0; offset < input.byteLength; offset += chunkBytes) {
    const written = await parser.write(input.subarray(offset, offset + chunkBytes));
    if (!written.ok) return;
  }
}

async function writeStringInput(
  parser: ChunkedInkbookInputParser,
  input: string,
  chunkCodeUnits: number,
): Promise<void> {
  const encoder = new TextEncoder();
  for (let offset = 0; offset < input.length;) {
    let end = Math.min(input.length, offset + chunkCodeUnits);
    const trailing = input.charCodeAt(end - 1);
    if (end < input.length && trailing >= 0xd800 && trailing <= 0xdbff) end -= 1;
    const written = await parser.write(encoder.encode(input.slice(offset, end)));
    if (!written.ok) return;
    offset = end;
  }
}
