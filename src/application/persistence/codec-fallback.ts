import {
  BOUNDED_JSON_PROCESS_MAX_UTF16_UNITS,
  createBoundedJsonProcessor,
  type BoundedJsonProcessor,
} from "../../domain/codecs";
import {
  decodeBoundedInkbookSidecarV1,
  SIDECAR_RESOURCE_LIMITS_V1,
} from "./codec";
import { createResumableSidecarEncodeProcessorV1 } from "./codec-encode-processor";
import {
  type PersistenceCodecWorkResultV1,
  type PersistenceCodecWorkV1,
  type PersistenceParseWorkV1,
} from "./codec-work";
import { PersistenceElementChunkCacheV1 } from "./element-chunk-cache";
import {
  createPreparedCanonicalSidecarProcessorV1,
  type PreparedCanonicalSidecarProcessorV1,
} from "./prepared-sidecar-processor";
import { validateSidecarVersionStructure } from "./validation";

export interface PersistenceFallbackProcessorV1<TResult> {
  /** Performs one bounded resumable unit and returns true only when complete. */
  processNext(): boolean;
  /** Returns the completed value without parsing, validation, or encoding work. */
  complete(): TResult;
  dispose(): void;
}

export function createPersistenceCodecFallbackProcessorV1(
  work: PersistenceCodecWorkV1,
  elementCache = new PersistenceElementChunkCacheV1(),
): PersistenceFallbackProcessorV1<PersistenceCodecWorkResultV1> {
  return work.kind === "parse-sidecar"
    ? new ParseFallbackProcessor(work)
    : new EncodeFallbackProcessor(work, elementCache);
}

class ParseFallbackProcessor implements PersistenceFallbackProcessorV1<PersistenceCodecWorkResultV1> {
  readonly #parser: BoundedJsonProcessor;
  #preparation: PreparedCanonicalSidecarProcessorV1 | undefined;
  #result: PersistenceCodecWorkResultV1 | undefined;
  #disposed = false;

  constructor(work: PersistenceParseWorkV1) {
    this.#parser = createBoundedJsonProcessor(
      work.rawText,
      SIDECAR_RESOURCE_LIMITS_V1,
    );
  }

  processNext(): boolean {
    this.assertUsable();
    if (this.#preparation !== undefined) return this.processPreparation();
    if (!this.#parser.done) {
      this.#parser.processNext(BOUNDED_JSON_PROCESS_MAX_UTF16_UNITS);
      return false;
    }
    const parsed = this.#parser.complete();
    if (parsed === undefined) throw new Error("Sidecar parse is incomplete.");
    if (!parsed.ok || isFutureSidecar(parsed.value)) {
      this.#result = Object.freeze({
        wireVersion: 1,
        kind: "parsed-sidecar",
        value: decodeBoundedInkbookSidecarV1(parsed),
      });
      return true;
    }
    this.#preparation = createPreparedCanonicalSidecarProcessorV1(
      parsed.value,
      parsed.counters.utf8Bytes,
    );
    return false;
  }

  private processPreparation(): boolean {
    const preparation = this.#preparation;
    if (preparation === undefined)
      throw new Error("Missing sidecar validation.");
    if (!preparation.done) {
      preparation.processNext();
      return false;
    }
    const prepared = preparation.complete();
    if (prepared === undefined)
      throw new Error("Sidecar validation is incomplete.");
    this.#result = Object.freeze({
      wireVersion: 1,
      kind: "parsed-sidecar",
      value: Object.freeze({
        kind: "current",
        sidecar: Object.freeze({
          ...prepared.sidecarWithoutElements,
          scene: Object.freeze({
            ...prepared.sidecarWithoutElements.scene,
            elements: prepared.elements,
          }),
        }),
      }),
    });
    return true;
  }

  complete(): PersistenceCodecWorkResultV1 {
    this.assertUsable();
    if (this.#result === undefined)
      throw new Error("Sidecar parse is incomplete.");
    return this.#result;
  }

  dispose(): void {
    this.#disposed = true;
    this.#result = undefined;
    this.#preparation?.dispose();
  }

  private assertUsable(): void {
    if (this.#disposed) throw new Error("Sidecar parse is disposed.");
  }
}

class EncodeFallbackProcessor implements PersistenceFallbackProcessorV1<PersistenceCodecWorkResultV1> {
  #result: PersistenceCodecWorkResultV1 | undefined;
  #preparation: PreparedCanonicalSidecarProcessorV1 | undefined;
  #encoder:
    PersistenceFallbackProcessorV1<PersistenceCodecWorkResultV1> | undefined;
  #disposed = false;

  constructor(
    private readonly work: Extract<
      PersistenceCodecWorkV1,
      { readonly kind: "encode-sidecar" }
    >,
    private readonly elementCache: PersistenceElementChunkCacheV1,
  ) {}

  processNext(): boolean {
    this.assertUsable();
    if (this.#encoder !== undefined) return this.processEncoder();
    this.#preparation ??= createPreparedCanonicalSidecarProcessorV1(
      this.work.sidecar,
    );
    if (!this.#preparation.done) {
      this.#preparation.processNext();
      return false;
    }
    const prepared = this.#preparation.complete();
    if (prepared === undefined)
      throw new Error("Sidecar validation is incomplete.");
    this.#encoder = createResumableSidecarEncodeProcessorV1({
      prepared,
      writableTier: this.work.writableTier,
      noteKey: this.work.sidecar.noteIdentity.vaultRelativeMarkdownPath,
      affectedElementIds: this.work.affectedElementIds,
      elementCache: this.elementCache,
    });
    return false;
  }

  private processEncoder(): boolean {
    const encoder = this.#encoder;
    if (encoder === undefined) throw new Error("Missing sidecar encoder.");
    if (!encoder.processNext()) return false;
    this.#result = encoder.complete();
    return true;
  }

  complete(): PersistenceCodecWorkResultV1 {
    this.assertUsable();
    if (this.#result === undefined)
      throw new Error("Sidecar encode is incomplete.");
    return this.#result;
  }

  dispose(): void {
    this.#disposed = true;
    this.#result = undefined;
    this.#preparation?.dispose();
    this.#encoder?.dispose();
  }

  private assertUsable(): void {
    if (this.#disposed) throw new Error("Sidecar encode is disposed.");
  }
}

function isFutureSidecar(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const version = validateSidecarVersionStructure(
    (value as Record<string, unknown>).schemaVersion,
  );
  return version.major !== 1 || version.minor !== 0;
}
