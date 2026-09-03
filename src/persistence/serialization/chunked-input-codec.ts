import type {
  InkSnapshotV1,
  SnapshotValidationDerivations,
  ValidationError,
} from "../../domain/schema/public";
import { FILE_SCHEMA_LIMITS, MAX_JSON_DEPTH } from "../../domain/schema/public";
import { jsonContainerBudget, jsonNodeBudget } from "../../domain/schema/validation-internals";
import {
  validateEditableSafeSvgPrelude,
  type SafeSvgPrelude,
} from "../documents/safe-svg-validator";
import { backgroundFitsStaticLimit } from "./background";
import { validateCurrentMetadataIntegrity } from "./canonical-metadata";
import {
  ChunkedJsonCancelledError,
  ChunkedJsonParseError,
  parseChunkedJson,
} from "./chunked-json-parser";
import {
  ChunkedInputCancelledError,
  type ChunkedInkbookInputOptions,
  type ChunkedInputCheckpoint,
} from "./chunked-input-types";
import { combineInputBytes, positiveInputInteger } from "./chunked-input-utils";
import { isCanonicalLockedHeight } from "./locked-height";
import { ChunkedSha256 } from "./chunked-output-sha256";
import {
  migrateAndValidateDocumentSnapshotSteps,
  type MigratedSnapshot,
} from "./document-migration";
import type { DocumentHashPort } from "./sha256";
import type {
  DocumentCodecError,
  DocumentCodecErrorCode,
  DocumentCodecResult,
  ParsedInkbookDocument,
} from "./types";
import { StreamingStaticIntegrityMatcher } from "./streaming-static-integrity";
import {
  StreamingSvgMetadataParser,
  type CompleteStreamingSvgMetadata,
} from "./streaming-svg-metadata";

const DEFAULT_INPUT_SLICE_BYTES = 256 * 1024;
const JSON_STRING_SCRATCH_CHARACTERS = 16 * 1024;
const MAXIMUM_PREFIX_CHARACTERS = 64 * 1024;
const METADATA_INPUT_CODE_UNITS_PER_STEP = 16 * 1024;

const IMMEDIATE_CHUNKED_INPUT_CHECKPOINT: ChunkedInputCheckpoint = () => Promise.resolve();

export type { ChunkedInkbookInputOptions, ChunkedInputCheckpoint };

/** Incrementally decodes bounded input and drives safe-SVG and snapshot validation steps. */
export class ChunkedInkbookInputParser {
  readonly #checkpoint: ChunkedInputCheckpoint;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #hasher: DocumentHashPort | null;
  readonly #incrementalHash: ChunkedSha256;
  readonly #inputSliceBytes: number;
  readonly #onValidatedSnapshot:
    | ((
        snapshot: InkSnapshotV1,
        derivations: SnapshotValidationDerivations,
      ) => Promise<void> | void)
    | undefined;
  readonly #signal: AbortSignal | undefined;
  readonly #byteChunks: Uint8Array[] = [];
  readonly #metadata = new StreamingSvgMetadataParser(FILE_SCHEMA_LIMITS.metadataBytes);
  #bytes = 0;
  #bytesSinceCheckpoint = 0;
  #failure: DocumentCodecResult<never> | null = null;
  #migrated: MigratedSnapshot | null = null;
  #maximumStaticChunkCharacters = 0;
  #prefix = "";
  #prelude: SafeSvgPrelude | null = null;
  #runtimeSnapshot: InkSnapshotV1 | null = null;
  #state: "cancelled" | "collecting" | "finishing" | "finished" = "collecting";
  #staticMatcher: StreamingStaticIntegrityMatcher | null = null;
  #streamPhase: "metadata" | "prefix" | "static" = "prefix";

  public constructor(options: ChunkedInkbookInputOptions = {}) {
    this.#checkpoint = options.checkpoint ?? IMMEDIATE_CHUNKED_INPUT_CHECKPOINT;
    this.#hasher = options.hasher ?? null;
    this.#incrementalHash = new ChunkedSha256();
    this.#inputSliceBytes = positiveInputInteger(
      options.inputSliceBytes ?? DEFAULT_INPUT_SLICE_BYTES,
      "inputSliceBytes",
    );
    positiveInputInteger(options.pathBatchSize ?? 128, "pathBatchSize");
    this.#onValidatedSnapshot = options.onValidatedSnapshot;
    this.#signal = options.signal;
  }

  public get bytesReceived(): number {
    return this.#bytes;
  }

  public get maximumRetainedStaticInputCharacters(): number {
    return this.#maximumStaticChunkCharacters;
  }

  public async write(chunk: Uint8Array): Promise<DocumentCodecResult<undefined>> {
    this.#assertCollecting();
    this.#throwIfCancelled();
    if (this.#bytes + chunk.byteLength > FILE_SCHEMA_LIMITS.totalInputBytes) {
      this.#failure = failure("invalid-svg", "Document exceeds the 64 MiB input limit.");
      return this.#failure;
    }

    const owned = new Uint8Array(chunk);
    if (this.#hasher !== null) this.#byteChunks.push(owned);
    this.#bytes += owned.byteLength;
    if (this.#failure !== null) return this.#failure;
    const decoding = await this.#decode(owned);
    if (!decoding.ok) return decoding;
    if (this.#bytesSinceCheckpoint > 0) {
      this.#bytesSinceCheckpoint = 0;
      const checkpoint = this.#runCheckpoint();
      if (checkpoint !== null) await checkpoint;
    }
    return { ok: true, value: undefined };
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
    this.#state = "finishing";
    try {
      if (this.#failure !== null) return this.#failure;
      const flushed = await this.#flushDecoder();
      if (!flushed.ok) return flushed;
      if (
        this.#streamPhase !== "static" ||
        this.#staticMatcher === null ||
        !this.#staticMatcher.finish() ||
        this.#migrated === null ||
        this.#runtimeSnapshot === null ||
        this.#prelude === null
      ) {
        return failure("invalid-svg", "Document does not satisfy the safe SVG envelope.");
      }
      const beforeHash = this.#runCheckpoint();
      if (beforeHash !== null) await beforeHash;
      return {
        ok: true,
        value: {
          derivations: this.#migrated.derivations,
          hash: this.#completeHash(),
          lockedHeight: this.#prelude.lockedHeight,
          requiresCanonicalRewrite: this.#prelude.requiresCanonicalRewrite,
          snapshot: this.#runtimeSnapshot,
          sourceVersion: this.#migrated.sourceVersion,
        },
      };
    } finally {
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
    const migrated = await runSteps(
      migrateAndValidateDocumentSnapshotSteps(parsed.value, {
        metadataBytes,
        totalInputBytes: this.#bytes,
      }),
      () => this.#runCheckpoint(),
    );
    if (!migrated.ok) return migrated;
    const integrity = validateCurrentMetadataIntegrity(
      metadataText,
      this.#prelude?.snapshotHash ?? null,
      migrated.value,
    );
    return integrity.ok ? migrated : integrity;
  }

  async #parseMetadata(metadataText: string): Promise<DocumentCodecResult<unknown>> {
    try {
      const checkpoint =
        this.#checkpoint === IMMEDIATE_CHUNKED_INPUT_CHECKPOINT
          ? undefined
          : async (): Promise<void> => {
              const pending = this.#runCheckpoint();
              if (pending !== null) await pending;
            };
      const value = await parseChunkedJson(metadataText, {
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
        if (this.#hasher === null) this.#incrementalHash.update(inputSlice);
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
    this.#maximumStaticChunkCharacters = Math.max(this.#maximumStaticChunkCharacters, input.length);
    if (this.#staticMatcher?.write(input) !== true) {
      return this.#staticFailure();
    }
    return { ok: true, value: undefined };
  }

  async #consumePrefix(input: string): Promise<DocumentCodecResult<undefined>> {
    this.#prefix += input;
    if (this.#prefix.length > MAXIMUM_PREFIX_CHARACTERS) {
      return failure("invalid-svg", "Document SVG prefix exceeds its bounded envelope.");
    }
    let candidateEnd = this.#prefix.indexOf(">");
    while (candidateEnd >= 0) {
      const candidate = this.#prefix.slice(0, candidateEnd + 1);
      const prelude = validateEditableSafeSvgPrelude(candidate);
      if (prelude !== null) {
        const remaining = this.#prefix.slice(candidateEnd + 1);
        this.#prefix = "";
        this.#prelude = prelude;
        this.#streamPhase = "metadata";
        return this.#consumeMetadata(remaining);
      }
      candidateEnd = this.#prefix.indexOf(">", candidateEnd + 1);
    }
    return { ok: true, value: undefined };
  }

  async #consumeMetadata(input: string): Promise<DocumentCodecResult<undefined>> {
    let offset = 0;
    while (offset < input.length) {
      const end = metadataSliceEnd(input, offset);
      const result = this.#metadata.consume(input.slice(offset, end));
      offset = end;
      if (result.kind === "invalid") {
        return failure("invalid-svg", "Document snapshot metadata is not safe XML text.");
      }
      if (result.kind === "complete") {
        return this.#completeMetadata(result, input, offset);
      }
      if (offset < input.length) await this.#checkpointMetadataSlice();
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
    if (!this.#writeStaticChunk(metadata.trailing)) return this.#staticFailure();
    return this.#consumeStaticRemainder(input, offset);
  }

  async #consumeStaticRemainder(
    input: string,
    initialOffset: number,
  ): Promise<DocumentCodecResult<undefined>> {
    let offset = initialOffset;
    while (offset < input.length) {
      const end = Math.min(offset + METADATA_INPUT_CODE_UNITS_PER_STEP, input.length);
      if (!this.#writeStaticChunk(input.slice(offset, end))) return this.#staticFailure();
      offset = end;
      if (offset < input.length) await this.#checkpointMetadataSlice();
    }
    return { ok: true, value: undefined };
  }

  #writeStaticChunk(input: string): boolean {
    this.#maximumStaticChunkCharacters = Math.max(this.#maximumStaticChunkCharacters, input.length);
    return this.#staticMatcher?.write(input) === true;
  }

  async #checkpointMetadataSlice(): Promise<void> {
    const checkpoint = this.#runCheckpoint();
    if (checkpoint !== null) await checkpoint;
  }

  async #initializeStaticMatcher(
    migrated: MigratedSnapshot,
  ): Promise<DocumentCodecResult<undefined>> {
    const prelude = this.#prelude!;
    if (migrated.sourceVersion !== prelude.version) {
      return failure("migration-failed", "Root and snapshot source versions do not match.");
    }
    const snapshot = migrated.snapshot;
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
    this.#staticMatcher = new StreamingStaticIntegrityMatcher(snapshot, prelude.lockedHeight);
    this.#runtimeSnapshot = snapshot;
    this.#streamPhase = "static";
    await this.#onValidatedSnapshot?.(snapshot, migrated.derivations);
    this.#throwIfCancelled();
    return { ok: true, value: undefined };
  }

  #staticFailure(): DocumentCodecResult<never> {
    return this.#staticMatcher?.failure === "invalid-svg"
      ? failure("invalid-svg", "Document does not satisfy the safe SVG envelope.")
      : failure(
          "static-path-mismatch",
          "Static SVG paths do not match the canonical snapshot rendering.",
        );
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
    return this.#checkpoint === IMMEDIATE_CHUNKED_INPUT_CHECKPOINT
      ? null
      : this.#waitForCheckpoint();
  }

  async #waitForCheckpoint(): Promise<void> {
    await this.#checkpoint();
    this.#throwIfCancelled();
  }

  #assertCollecting(): void {
    if (this.#state === "cancelled") throw new ChunkedInputCancelledError();
    if (this.#state !== "collecting") {
      throw new Error("Chunked document input is no longer accepting data.");
    }
  }

  #throwIfCancelled(): void {
    if (this.#signal?.aborted === true) {
      this.#state = "cancelled";
      this.#releaseBuffers();
      throw new ChunkedInputCancelledError();
    }
  }

  #releaseBuffers(): void {
    this.#byteChunks.length = 0;
    this.#metadata.release();
    this.#prefix = "";
  }

  #completeHash(): string {
    if (this.#hasher === null) return this.#incrementalHash.digestHex();
    return this.#hasher.hash(combineInputBytes(this.#byteChunks, this.#bytes));
  }

  #markFinished(): void {
    if (this.#state !== "cancelled") this.#state = "finished";
  }
}

async function runSteps<T>(
  iterator: Generator<void, T>,
  checkpoint: () => Promise<void> | null,
): Promise<T> {
  let step = iterator.next();
  while (!step.done) {
    const pending = checkpoint();
    if (pending !== null) await pending;
    step = iterator.next();
  }
  return step.value;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function metadataSliceEnd(input: string, offset: number): number {
  let end = Math.min(offset + METADATA_INPUT_CODE_UNITS_PER_STEP, input.length);
  if (end < input.length && isHighSurrogate(input.charCodeAt(end - 1))) end -= 1;
  return end;
}

function failure<T>(
  code: DocumentCodecErrorCode,
  message: string,
  validationError?: ValidationError,
): DocumentCodecResult<T> {
  const error: DocumentCodecError =
    validationError === undefined ? { code, message } : { code, message, validationError };
  return { error, ok: false };
}
