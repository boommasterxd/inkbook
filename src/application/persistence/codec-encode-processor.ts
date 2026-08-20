import type { ElementId, SceneElementV1 } from "../../domain/model";
import {
  assertWritableSidecarSizeV1,
  type PreparedCanonicalSidecarV1,
} from "./codec";
import type { SidecarWritableTierV1 } from "./types";
import {
  bytesMatch,
  CanonicalUtf8Processor,
  OutputAssembly,
} from "./codec-encode-processor-support";
import type { PersistenceFallbackProcessorV1 } from "./codec-fallback";
import {
  PERSISTENCE_CODEC_CHUNK_UNITS_V1,
  PERSISTENCE_CODEC_WIRE_VERSION_V1,
  type PersistenceEncodedWorkResultV1,
} from "./codec-work";
import {
  createPersistenceEncodedElementChunkV1,
  PersistenceElementChunkCacheV1,
  type PersistenceElementChunkCacheUseV1,
  type PersistenceEncodedElementChunkV1,
} from "./element-chunk-cache";

const NO_OFFSET = -1;
const ELEMENT_MARKER = Object.freeze({
  $inkbookEncodedElementChunksV1: true,
});

type EncodeStage =
  | "affected"
  | "elements"
  | "element-bytes"
  | "marker"
  | "scaffold"
  | "find-marker"
  | "allocate"
  | "assemble"
  | "plan"
  | "publish"
  | "done"
  | "disposed";

export interface ResumableSidecarEncodeOptionsV1 {
  readonly prepared: PreparedCanonicalSidecarV1;
  readonly writableTier: SidecarWritableTierV1;
  readonly noteKey: string;
  readonly affectedElementIds: readonly ElementId[];
  readonly elementCache: PersistenceElementChunkCacheV1;
}

export function createResumableSidecarEncodeProcessorV1(
  options: ResumableSidecarEncodeOptionsV1,
): PersistenceFallbackProcessorV1<PersistenceEncodedWorkResultV1> {
  return new SidecarEncodeProcessor(options);
}

class SidecarEncodeProcessor implements PersistenceFallbackProcessorV1<PersistenceEncodedWorkResultV1> {
  #prepared: PreparedCanonicalSidecarV1 | null;
  readonly #tier: SidecarWritableTierV1;
  readonly #noteKey: string;
  #affectedIds: readonly ElementId[];
  #cache: PersistenceElementChunkCacheV1 | null;
  #cacheUse: PersistenceElementChunkCacheUseV1 | null;
  readonly #affected = new Set<ElementId>();
  #elementChunks: PersistenceEncodedElementChunkV1[] = [];
  #ownedChunks = new Map<ElementId, PersistenceEncodedElementChunkV1>();
  #bytePlan: { offset: number; length: number }[] = [];
  #stage: EncodeStage = "affected";
  #affectedIndex = 0;
  #elementIndex = 0;
  #elementBytes = 0;
  #ownedChunkBytes = 0;
  #encodedElementCount = 0;
  #activeElement: SceneElementV1 | null = null;
  #valueEncoder: CanonicalUtf8Processor | null = null;
  #markerBytes: Uint8Array<ArrayBuffer> | null = null;
  #scaffoldBytes: Uint8Array<ArrayBuffer> | null = null;
  #markerOffset = NO_OFFSET;
  #markerScanOffset = 0;
  #output: Uint8Array<ArrayBuffer> | null = null;
  #assembly = new OutputAssembly();
  #planOffset = 0;
  #result: PersistenceEncodedWorkResultV1 | null = null;

  constructor(options: ResumableSidecarEncodeOptionsV1) {
    this.#prepared = options.prepared;
    this.#tier = options.writableTier;
    this.#noteKey = options.noteKey;
    this.#affectedIds = options.affectedElementIds;
    this.#cache = options.elementCache;
    this.#cacheUse = options.elementCache.beginUse(options.noteKey);
  }

  processNext(): boolean {
    this.assertUsable();
    switch (this.#stage) {
      case "affected":
        return this.processAffectedId();
      case "elements":
        return this.processElement();
      case "element-bytes":
        return this.processElementBytes();
      case "marker":
      case "scaffold":
        this.processScaffoldValue();
        return false;
      case "find-marker":
        return this.processMarkerSearch();
      case "allocate":
        return this.allocateOutput();
      case "assemble":
        this.processAssembly();
        return false;
      case "plan":
        return this.processBytePlan();
      case "publish":
        return this.publish();
      case "done":
        return true;
      case "disposed":
        throw new Error("Sidecar encode is disposed.");
    }
  }

  complete(): PersistenceEncodedWorkResultV1 {
    this.assertUsable();
    if (this.#result === null) throw new Error("Sidecar encode is incomplete.");
    return this.#result;
  }

  dispose(): void {
    if (this.#stage === "disposed") return;
    this.#stage = "disposed";
    this.#prepared = null;
    this.#affectedIds = [];
    this.#cache = null;
    this.#cacheUse?.release();
    this.#cacheUse = null;
    this.#valueEncoder?.dispose();
    this.#valueEncoder = null;
    this.#activeElement = null;
    this.#elementChunks = [];
    this.#ownedChunks = new Map();
    this.#ownedChunkBytes = 0;
    this.#bytePlan = [];
    this.#markerBytes = null;
    this.#scaffoldBytes = null;
    this.#output = null;
    this.#assembly.dispose();
    this.#result = null;
  }

  private processAffectedId(): boolean {
    const affectedId = this.#affectedIds[this.#affectedIndex];
    if (affectedId !== undefined) {
      this.#affected.add(affectedId);
      this.#affectedIndex += 1;
      return false;
    }
    this.#stage = "elements";
    return false;
  }

  private processElement(): boolean {
    const element = this.requiredPrepared().elements[this.#elementIndex];
    if (element === undefined) {
      this.startValueEncoding(ELEMENT_MARKER, "marker");
      return false;
    }
    const reusable = this.requiredCache().findReusable(
      this.#noteKey,
      element,
      this.#affected.has(element.elementId),
    );
    if (reusable !== undefined) {
      this.acceptElementChunk(reusable);
      return false;
    }
    this.#activeElement = element;
    this.#valueEncoder = new CanonicalUtf8Processor(element);
    this.#stage = "element-bytes";
    return false;
  }

  private processElementBytes(): boolean {
    const encoder = this.requiredEncoder();
    if (!encoder.processNext()) return false;
    const element = this.#activeElement;
    if (element === null) throw new Error("Missing active sidecar element.");
    const chunk = createPersistenceEncodedElementChunkV1(
      element,
      encoder.complete(),
    );
    this.#encodedElementCount += 1;
    this.#activeElement = null;
    this.#valueEncoder = null;
    this.#stage = "elements";
    this.acceptElementChunk(chunk);
    return false;
  }

  private acceptElementChunk(chunk: PersistenceEncodedElementChunkV1): void {
    if (this.#elementChunks.length > 0) this.#elementBytes += 1;
    this.#elementBytes += chunk.bytes.byteLength;
    this.#elementChunks.push(chunk);
    const replaced = this.#ownedChunks.get(chunk.elementId);
    if (replaced !== undefined) {
      this.#ownedChunkBytes -= replaced.bytes.byteLength;
    }
    this.#ownedChunks.set(chunk.elementId, chunk);
    this.#ownedChunkBytes += chunk.bytes.byteLength;
    this.#elementIndex += 1;
  }

  private processScaffoldValue(): void {
    const encoder = this.requiredEncoder();
    if (!encoder.processNext()) return;
    const bytes = encoder.complete();
    this.#valueEncoder = null;
    if (this.#stage === "marker") {
      this.#markerBytes = bytes;
      this.startValueEncoding(this.scaffoldValue(), "scaffold");
    } else {
      this.#scaffoldBytes = bytes;
      this.#stage = "find-marker";
    }
  }

  private startValueEncoding(
    value: unknown,
    stage: "marker" | "scaffold",
  ): void {
    this.#valueEncoder = new CanonicalUtf8Processor(value);
    this.#stage = stage;
  }

  private scaffoldValue(): unknown {
    const sidecar = this.requiredPrepared().sidecarWithoutElements;
    return {
      ...sidecar,
      scene: { ...sidecar.scene, elements: [ELEMENT_MARKER] },
    };
  }

  private processMarkerSearch(): boolean {
    const scaffold = this.requiredScaffold();
    const marker = this.requiredMarker();
    const stop = Math.min(
      scaffold.length - marker.length + 1,
      this.#markerScanOffset + PERSISTENCE_CODEC_CHUNK_UNITS_V1,
    );
    for (; this.#markerScanOffset < stop; this.#markerScanOffset += 1) {
      if (!bytesMatch(scaffold, marker, this.#markerScanOffset)) continue;
      if (this.#markerOffset !== NO_OFFSET) {
        throw new Error("Canonical sidecar element marker is not unique.");
      }
      this.#markerOffset = this.#markerScanOffset;
    }
    if (this.#markerScanOffset < scaffold.length - marker.length + 1) {
      return false;
    }
    if (this.#markerOffset === NO_OFFSET) {
      throw new Error("Canonical sidecar element marker is missing.");
    }
    this.#stage = "allocate";
    return false;
  }

  private allocateOutput(): boolean {
    const scaffold = this.requiredScaffold();
    const marker = this.requiredMarker();
    const byteLength =
      scaffold.byteLength - marker.byteLength + this.#elementBytes + 1;
    assertWritableSidecarSizeV1(byteLength, this.#tier);
    this.#output = new Uint8Array(byteLength);
    this.#assembly.start(
      this.#output,
      scaffold,
      this.#markerOffset,
      marker.byteLength,
      this.#elementChunks,
    );
    this.#stage = "assemble";
    return false;
  }

  private processAssembly(): void {
    if (this.#assembly.processNext()) this.#stage = "plan";
  }

  private processBytePlan(): boolean {
    const output = this.requiredOutput();
    if (this.#planOffset >= output.byteLength) {
      this.#stage = "publish";
      return false;
    }
    const length = Math.min(
      PERSISTENCE_CODEC_CHUNK_UNITS_V1,
      output.byteLength - this.#planOffset,
    );
    this.#bytePlan.push(Object.freeze({ offset: this.#planOffset, length }));
    this.#planOffset += length;
    return false;
  }

  private publish(): boolean {
    const result = Object.freeze({
      wireVersion: PERSISTENCE_CODEC_WIRE_VERSION_V1,
      kind: "encoded-sidecar" as const,
      bytes: this.requiredOutput(),
      byteChunks: Object.freeze(this.#bytePlan),
      elementCount: this.#elementChunks.length,
      encodedElementCount: this.#encodedElementCount,
      reusedElementCount:
        this.#elementChunks.length - this.#encodedElementCount,
    });
    this.requiredCache().commitOwned(
      this.#noteKey,
      this.#ownedChunks,
      this.#ownedChunkBytes,
    );
    this.#cacheUse?.release();
    this.#cacheUse = null;
    this.#ownedChunks = new Map();
    this.#ownedChunkBytes = 0;
    this.#elementChunks = [];
    this.#assembly.dispose();
    this.#result = result;
    this.#stage = "done";
    return true;
  }

  private requiredEncoder(): CanonicalUtf8Processor {
    if (this.#valueEncoder === null) throw new Error("Missing value encoder.");
    return this.#valueEncoder;
  }

  private requiredMarker(): Uint8Array<ArrayBuffer> {
    if (this.#markerBytes === null) throw new Error("Missing marker bytes.");
    return this.#markerBytes;
  }

  private requiredScaffold(): Uint8Array<ArrayBuffer> {
    if (this.#scaffoldBytes === null)
      throw new Error("Missing scaffold bytes.");
    return this.#scaffoldBytes;
  }

  private requiredOutput(): Uint8Array<ArrayBuffer> {
    if (this.#output === null) throw new Error("Missing sidecar output.");
    return this.#output;
  }

  private requiredPrepared(): PreparedCanonicalSidecarV1 {
    if (this.#prepared === null) throw new Error("Missing prepared sidecar.");
    return this.#prepared;
  }

  private requiredCache(): PersistenceElementChunkCacheV1 {
    if (this.#cache === null) throw new Error("Missing sidecar element cache.");
    return this.#cache;
  }

  private assertUsable(): void {
    if (this.#stage === "disposed")
      throw new Error("Sidecar encode is disposed.");
  }
}
