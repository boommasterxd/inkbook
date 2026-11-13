import { StreamingSafeStaticValidator } from "./streaming-safe-static";
import { SafeStaticProof } from "./safe-static-proof";
import { StrokeSampleEncodingCache } from "../metadata/stroke-sample-encoding-cache";
import {
  ValidatedSnapshotAdoption,
  type ValidatedSnapshotConsumer,
} from "../metadata/validated-snapshot-adoption";
import type { InkSnapshotV1 } from "../../../domain/schema/public";
import { FILE_SCHEMA_LIMITS, MAX_JSON_DEPTH } from "../../../domain/schema/public";
import { jsonContainerBudget, jsonNodeBudget } from "../../../domain/schema/validation-internals";
import type { SafeSvgPrelude } from "../../documents/safe-svg-validator";
import { SvgInputPrelude } from "./svg-input-prelude";
import { backgroundFitsStaticLimit } from "../output/background";
import { validateParsedMetadata } from "./parsed-metadata-validation";
import {
  ChunkedJsonCancelledError,
  ChunkedJsonParseError,
  parseChunkedJsonWithProof,
} from "./chunked-json-parser";
import {
  ChunkedInputCancelledError,
  type ChunkedInkbookInputOptions,
  type ChunkedInputCheckpoint,
} from "./chunked-input-types";
import {
  positiveInputInteger,
  inputFailure as failure,
  metadataSliceEnd,
  staticInputFailure,
} from "./chunked-input-utils";
import { requiresTextLengthRewrite } from "./text-length-rewrite";
import { isCanonicalLockedHeight } from "../output/locked-height";
import { prepareValidatedTextFontBindings } from "./validated-text-font-bindings";
import { ChunkedInputHash } from "./chunked-input-hash";
import type { MigratedSnapshot } from "../metadata/document-migration";
import type { DocumentCodecResult, ParsedInkbookDocument } from "../types";
import { StreamingStaticIntegrityMatcher } from "./streaming-static-integrity";
import {
  StreamingSvgMetadataParser,
  type CompleteStreamingSvgMetadata,
} from "./streaming-svg-metadata";

const DEFAULT_INPUT_SLICE_BYTES = 256 * 1024;
const JSON_STRING_SCRATCH_CHARACTERS = 16 * 1024;
const METADATA_INPUT_CODE_UNITS_PER_STEP = 16 * 1024;
const IMMEDIATE_CHUNKED_INPUT_CHECKPOINT: ChunkedInputCheckpoint = () => undefined;

export type { ChunkedInkbookInputOptions, ChunkedInputCheckpoint };

/** Incrementally decodes bounded input and drives safe-SVG and snapshot validation steps. */
export class ChunkedInkbookInputParser {
  readonly #checkpoint: ChunkedInputCheckpoint;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #inputHash: ChunkedInputHash;
  readonly #inputSliceBytes: number;
  readonly #staticValidation: "canonical" | "safe";
  readonly #safeStaticProof: SafeStaticProof | undefined;
  readonly #sampleEncodingCache: StrokeSampleEncodingCache | undefined;
  readonly #stagedSampleEncodings: StrokeSampleEncodingCache | undefined;
  readonly #onValidatedSnapshot: ValidatedSnapshotConsumer | undefined;
  readonly #adoption: ValidatedSnapshotAdoption;
  readonly #signal: AbortSignal | undefined;
  readonly #metadata = new StreamingSvgMetadataParser(FILE_SCHEMA_LIMITS.metadataBytes);
  #bytes = 0;
  #bytesSinceCheckpoint = 0;
  #failure: DocumentCodecResult<never> | null = null;
  #migrated: MigratedSnapshot | null = null;
  #maximumStaticChunkCharacters = 0;
  readonly #prefix = new SvgInputPrelude();
  #prelude: SafeSvgPrelude | null = null;
  #runtimeSnapshot: InkSnapshotV1 | null = null;
  #state: "cancelled" | "collecting" | "finishing" | "finished" = "collecting";
  #staticMatcher: StreamingStaticIntegrityMatcher | StreamingSafeStaticValidator | null = null;
  #streamPhase: "metadata" | "prefix" | "static" = "prefix";

  public constructor(options: ChunkedInkbookInputOptions = {}) {
    this.#checkpoint = options.checkpoint ?? IMMEDIATE_CHUNKED_INPUT_CHECKPOINT;
    this.#inputSliceBytes = positiveInputInteger(
      options.inputSliceBytes ?? DEFAULT_INPUT_SLICE_BYTES,
      "inputSliceBytes",
    );
    positiveInputInteger(options.pathBatchSize ?? 128, "pathBatchSize");
    this.#onValidatedSnapshot = options.onValidatedSnapshot;
    this.#staticValidation = options.staticValidation ?? "canonical";
    this.#inputHash = new ChunkedInputHash(options);
    if (
      options.safeStaticProof !== undefined &&
      !SafeStaticProof.isAuthentic(options.safeStaticProof)
    ) {
      throw new TypeError("Safe SVG proof must come from an owned validation producer.");
    }
    if (options.safeStaticProof !== undefined && this.#inputHash.hasCustomHasher) {
      throw new TypeError("Safe SVG proof requires hashing the complete actual input bytes.");
    }
    this.#safeStaticProof = this.#staticValidation === "safe" ? options.safeStaticProof : undefined;
    this.#sampleEncodingCache = options.sampleEncodingCache;
    this.#stagedSampleEncodings =
      options.sampleEncodingCache === undefined ? undefined : new StrokeSampleEncodingCache();
    this.#signal = options.signal;
    this.#adoption = new ValidatedSnapshotAdoption(options.signal);
  }

  public get bytesReceived(): number {
    return this.#bytes;
  }

  public get retainedSampleEncodingBytes(): number {
    return this.#stagedSampleEncodings?.instrumentation.sampleEncodingCacheBytes ?? 0;
  }

  public get maximumRetainedStaticInputCharacters(): number {
    return (
      this.#maximumStaticChunkCharacters +
      (this.#staticMatcher instanceof StreamingSafeStaticValidator
        ? this.#staticMatcher.maximumRetainedCharacters
        : 0)
    );
  }

  public async write(chunk: Uint8Array): Promise<DocumentCodecResult<undefined>> {
    this.#assertCollecting();
    this.#throwIfCancelled();
    if (!this.#inputHash.beginWrite()) {
      this.#failure = failure("invalid-svg", "Concurrent owned export input is not supported.");
      this.#inputHash.release();
      return this.#failure;
    }
    try {
      if (this.#bytes + chunk.byteLength > FILE_SCHEMA_LIMITS.totalInputBytes) {
        this.#failure = failure("invalid-svg", "Document exceeds the 64 MiB input limit.");
        return this.#failure;
      }

      const owned = this.#inputHash.copy(chunk);
      if (owned === undefined) {
        this.#failure = failure("invalid-svg", "Document exceeds the owned export input capacity.");
        return this.#failure;
      }
      this.#bytes += owned.byteLength;
      if (this.#failure !== null) return this.#failure;
      const decoding = await this.#decode(owned);
      if (!decoding.ok) return decoding;
      if (this.#bytesSinceCheckpoint > 0) {
        this.#bytesSinceCheckpoint = 0;
        const checkpoint = this.#runCheckpoint();
        if (checkpoint !== null) await checkpoint;
      }
      return this.#failure ?? { ok: true, value: undefined };
    } finally {
      this.#inputHash.endWrite();
    }
  }

  public async pauseForInput(): Promise<void> {
    this.#assertCollecting();
    this.#throwIfCancelled();
    const checkpoint = this.#runCheckpoint();
    if (checkpoint !== null) await checkpoint;
  }

  public async finish(): Promise<DocumentCodecResult<ParsedInkbookDocument>> {
    this.#assertCollecting();
    this.#throwIfCancelled();
    if (this.#inputHash.writePending) {
      this.#failure = failure("invalid-svg", "Owned export input is still being written.");
    }
    this.#state = "finishing";
    try {
      if (this.#failure !== null) return this.#failure;
      const flushed = await this.#flushDecoder();
      if (!flushed.ok) return flushed;
      if (
        this.#streamPhase !== "static" ||
        (this.#safeStaticProof === undefined &&
          (this.#staticMatcher === null || !this.#staticMatcher.finish())) ||
        this.#migrated === null ||
        this.#runtimeSnapshot === null ||
        this.#prelude === null
      ) {
        return failure("invalid-svg", "Document does not satisfy the safe SVG envelope.");
      }
      await this.#adoption.finish();
      this.#throwIfCancelled();
      const beforeHash = this.#runCheckpoint();
      if (beforeHash !== null) await beforeHash;
      const completedHash = this.#inputHash.complete();
      if (completedHash === undefined) {
        return failure("invalid-svg", "Document bytes do not fill the owned export input.");
      }
      const hash = typeof completedHash === "string" ? completedHash : await completedHash;
      if (typeof completedHash !== "string") this.#throwIfCancelled();
      if (
        this.#safeStaticProof !== undefined &&
        !this.#safeStaticProof.matches(hash, this.#bytes)
      ) {
        return failure("invalid-svg", "Document bytes no longer match the owned safe SVG proof.");
      }
      this.#sampleEncodingCache?.adoptValidated(
        this.#stagedSampleEncodings!,
        this.#runtimeSnapshot,
        this.#migrated.sourceVersion,
      );
      return {
        ok: true,
        value: {
          derivations: this.#migrated.derivations,
          hash,
          lockedHeight: this.#prelude.lockedHeight,
          requiresCanonicalRewrite:
            this.#prelude.requiresCanonicalRewrite ||
            (await requiresTextLengthRewrite(
              this.#runtimeSnapshot,
              this.#staticMatcher,
              this.#safeStaticProof,
              () => this.#runCheckpoint() ?? undefined,
            )),
          snapshot: this.#runtimeSnapshot,
          sourceVersion: this.#migrated.sourceVersion,
        },
      };
    } finally {
      this.#adoption.cancel();
      const settling = this.#adoption.settle();
      if (settling !== undefined) await settling;
      this.#releaseBuffers();
      this.#markFinished();
    }
  }

  async #parseValidatedSnapshot(
    metadataText: string,
    metadataBytes: number,
  ): Promise<DocumentCodecResult<MigratedSnapshot>> {
    const beforeMetadata = this.#runCheckpoint();
    if (beforeMetadata !== null) await beforeMetadata;
    const parsed = await this.#parseMetadata(metadataText);
    if (!parsed.ok) return parsed;
    return validateParsedMetadata(parsed.value, {
      checkpoint: () => this.#runCheckpoint() ?? undefined,
      metadataBytes,
      metadataText,
      prelude: this.#prelude,
      ...(this.#signal === undefined ? {} : { signal: this.#signal }),
      staticValidation: this.#staticValidation,
      totalInputBytes: this.#bytes,
      ...(this.#stagedSampleEncodings === undefined
        ? {}
        : { sampleEncodingCache: this.#stagedSampleEncodings }),
    });
  }

  async #parseMetadata(
    metadataText: string,
  ): Promise<DocumentCodecResult<Awaited<ReturnType<typeof parseChunkedJsonWithProof>>>> {
    try {
      const checkpoint =
        this.#checkpoint === IMMEDIATE_CHUNKED_INPUT_CHECKPOINT
          ? undefined
          : () => this.#runCheckpoint() ?? undefined;
      const value = await parseChunkedJsonWithProof(metadataText, {
        batchCharacters: Math.min(this.#inputSliceBytes, METADATA_INPUT_CODE_UNITS_PER_STEP),
        ...(checkpoint === undefined ? {} : { checkpoint }),
        limits: {
          maximumContainerEntries: jsonContainerBudget(FILE_SCHEMA_LIMITS),
          maximumDepth: MAX_JSON_DEPTH,
          maximumNodes: jsonNodeBudget(FILE_SCHEMA_LIMITS),
          maximumOutputCharacters: metadataText.length,
          maximumStringScratchCharacters: JSON_STRING_SCRATCH_CHARACTERS,
        },
        ...(this.#signal === undefined ? {} : { signal: this.#signal }),
      });
      return { ok: true, value };
    } catch (error) {
      if (error instanceof ChunkedJsonCancelledError) this.#throwIfCancelled();
      if (error instanceof ChunkedJsonParseError) {
        return failure(
          "invalid-json",
          error.code === "duplicate-key"
            ? "Snapshot metadata is not canonical compact JSON."
            : "Snapshot metadata is not valid JSON.",
        );
      }
      throw error;
    }
  }

  async #decode(chunk: Uint8Array): Promise<DocumentCodecResult<undefined>> {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const remaining = this.#inputSliceBytes - this.#bytesSinceCheckpoint;
      const end = Math.min(offset + remaining, chunk.byteLength);
      let decoded: string;
      try {
        const inputSlice = chunk.subarray(offset, end);
        decoded = this.#decoder.decode(inputSlice, { stream: true });
        this.#inputHash.update(inputSlice);
      } catch {
        this.#failure = failure("invalid-utf8", "Document bytes are not valid UTF-8.");
        return this.#failure;
      }
      const consumed = await this.#consumeDecoded(decoded);
      if (!consumed.ok) {
        this.#failure = consumed;
        return consumed;
      }
      this.#bytesSinceCheckpoint += end - offset;
      offset = end;
      if (this.#bytesSinceCheckpoint === this.#inputSliceBytes) {
        this.#bytesSinceCheckpoint = 0;
        const checkpoint = this.#runCheckpoint();
        if (checkpoint !== null) await checkpoint;
      }
    }
    return { ok: true, value: undefined };
  }

  async #consumeDecoded(input: string): Promise<DocumentCodecResult<undefined>> {
    if (input.length === 0) return { ok: true, value: undefined };
    if (this.#streamPhase === "prefix") return this.#consumePrefix(input);
    if (this.#streamPhase === "metadata") return this.#consumeMetadata(input);
    if (!(await this.#writeStaticChunk(input))) {
      return staticInputFailure(this.#staticMatcher?.failure);
    }
    return { ok: true, value: undefined };
  }

  async #consumePrefix(input: string): Promise<DocumentCodecResult<undefined>> {
    const steps = this.#prefix.write(input);
    let step = steps.next();
    while (!step.done) {
      await this.#runCheckpoint();
      step = steps.next();
    }
    const parsed = step.value;
    if (!parsed.ok) return parsed;
    if (parsed.value === null) return { ok: true, value: undefined };
    this.#prelude = parsed.value.prelude;
    this.#streamPhase = "metadata";
    return this.#consumeMetadata(parsed.value.remaining);
  }

  async #consumeMetadata(input: string): Promise<DocumentCodecResult<undefined>> {
    let offset = 0;
    while (offset < input.length) {
      const end = metadataSliceEnd(input, offset, METADATA_INPUT_CODE_UNITS_PER_STEP);
      const result = this.#metadata.consume(input.slice(offset, end));
      offset = end;
      if (result.kind === "invalid") {
        return failure("invalid-svg", "Document snapshot metadata is not safe XML text.");
      }
      if (result.kind === "complete") {
        return this.#completeMetadata(result, input, offset);
      }
      if (offset < input.length) {
        const pending = this.#runCheckpoint();
        if (pending !== null) await pending;
      }
    }
    return { ok: true, value: undefined };
  }

  async #completeMetadata(
    metadata: CompleteStreamingSvgMetadata,
    input: string,
    offset: number,
  ): Promise<DocumentCodecResult<undefined>> {
    const migrated = await this.#parseValidatedSnapshot(
      metadata.metadataText,
      metadata.metadataBytes,
    );
    if (!migrated.ok) return migrated;
    const initialized = await this.#initializeStaticMatcher(migrated.value);
    if (!initialized.ok) return initialized;
    if (!(await this.#writeStaticChunk(metadata.trailing)))
      return staticInputFailure(this.#staticMatcher?.failure);
    return this.#consumeStaticRemainder(input, offset);
  }

  async #consumeStaticRemainder(
    input: string,
    initialOffset: number,
  ): Promise<DocumentCodecResult<undefined>> {
    let offset = initialOffset;
    while (offset < input.length) {
      const end = Math.min(offset + METADATA_INPUT_CODE_UNITS_PER_STEP, input.length);
      if (!(await this.#writeStaticChunk(input.slice(offset, end))))
        return staticInputFailure(this.#staticMatcher?.failure);
      offset = end;
      if (offset < input.length) {
        const pending = this.#runCheckpoint();
        if (pending !== null) await pending;
      }
    }
    return { ok: true, value: undefined };
  }

  async #writeStaticChunk(input: string): Promise<boolean> {
    if (this.#safeStaticProof !== undefined) return true;
    this.#maximumStaticChunkCharacters = Math.max(this.#maximumStaticChunkCharacters, input.length);
    return (await this.#staticMatcher?.write(input)) === true;
  }

  async #initializeStaticMatcher(
    migrated: MigratedSnapshot,
  ): Promise<DocumentCodecResult<undefined>> {
    const prelude = this.#prelude!;
    if (migrated.sourceVersion !== prelude.version) {
      return failure("migration-failed", "Root and snapshot source versions do not match.");
    }
    const snapshot = migrated.snapshot;
    const bound = await prepareValidatedTextFontBindings(
      snapshot,
      prelude,
      () => this.#runCheckpoint() ?? undefined,
    );
    if (!bound.ok) return bound;
    if (snapshot.revision !== prelude.revision) {
      return failure("revision-mismatch", "Root and snapshot revisions do not match.");
    }
    const maximumBottom = migrated.derivations.maximumBottom;
    if (!isCanonicalLockedHeight(snapshot.page, maximumBottom, prelude.lockedHeight)) {
      return failure(
        "locked-height-mismatch",
        "The SVG viewBox height is not the derived locked height.",
      );
    }
    if (
      !backgroundFitsStaticLimit(
        snapshot.page.background,
        prelude.lockedHeight,
        FILE_SCHEMA_LIMITS.totalInputBytes,
      )
    ) {
      return failure("static-path-mismatch", "Static SVG background exceeds the canonical limit.");
    }
    this.#migrated = migrated;
    this.#staticMatcher =
      this.#safeStaticProof !== undefined
        ? null
        : this.#staticValidation === "safe"
          ? new StreamingSafeStaticValidator(
              () => this.#runCheckpoint() ?? undefined,
              prelude.version,
            )
          : new StreamingStaticIntegrityMatcher(snapshot, prelude.lockedHeight);
    this.#runtimeSnapshot = bound.value.snapshot;
    if (bound.value.requiresCanonicalRewrite)
      this.#prelude = { ...prelude, requiresCanonicalRewrite: true };
    this.#streamPhase = "static";
    this.#adoption.start(bound.value.snapshot, migrated.derivations, this.#onValidatedSnapshot);
    this.#throwIfCancelled();
    return { ok: true, value: undefined };
  }

  async #flushDecoder(): Promise<DocumentCodecResult<undefined>> {
    let decoded: string;
    try {
      decoded = this.#decoder.decode();
    } catch {
      return failure("invalid-utf8", "Document bytes are not valid UTF-8.");
    }
    return this.#consumeDecoded(decoded);
  }

  #runCheckpoint(): Promise<void> | null {
    this.#throwIfCancelled();
    const pending =
      this.#checkpoint === IMMEDIATE_CHUNKED_INPUT_CHECKPOINT ? undefined : this.#checkpoint();
    if (pending === undefined) this.#throwIfCancelled();
    return pending === undefined ? null : pending.then(() => this.#throwIfCancelled());
  }

  #assertCollecting(): void {
    if (this.#state === "cancelled") throw new ChunkedInputCancelledError();
    if (this.#state !== "collecting") {
      throw new Error("Chunked document input is no longer accepting data.");
    }
  }

  #throwIfCancelled(): void {
    if (this.#signal?.aborted === true) {
      this.#adoption.cancel();
      this.#state = "cancelled";
      this.#releaseBuffers();
      throw new ChunkedInputCancelledError();
    }
  }

  #releaseBuffers(): void {
    this.#stagedSampleEncodings?.clear();
    this.#inputHash.release();
    this.#metadata.release();
    this.#prefix.clear();
    this.#prelude = null;
  }

  #markFinished(): void {
    if (this.#state !== "cancelled") this.#state = "finished";
  }
}
