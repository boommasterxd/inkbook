import { isStoredStroke } from "../../../domain/elements/stroke-replacement-proof";
import {
  createSampleCopyProof,
  isImmutableStrokeSampleSource,
} from "../../../domain/elements/runtime-sample-copy";
import type { InkElementV1, StrokeSamplesV1 } from "../../../domain/schema/public";
import type { ExecutorIdentity } from "../protocol";
import type { DocumentRuntimeRequest, DocumentRuntimeResult, UnlockRuntimeBatch } from "./types";

interface EncodedPointChanges {
  readonly points: Map<string, StrokeSamplesV1 | null>;
  readonly lengths: Map<string, number>;
  readonly ownedPoints: Set<StrokeSamplesV1>;
  readonly removedIds: readonly string[];
}

const MAX_RETIRED_BYTES = 32 * 1024 * 1024;
const MAX_RETIRED_ELEMENTS = 20_000;

interface RetiredPoints {
  readonly points: StrokeSamplesV1 | undefined;
  readonly bytes: number;
}

/** Holds only the acknowledged model; failed or superseded requests never publish references. */
export class ModelPointReferences {
  readonly #points = new Map<string, StrokeSamplesV1>();
  readonly #lengths = new Map<string, number>();
  readonly #retired = new Map<string, RetiredPoints>();
  #retiredBytes = 0;
  readonly #encodedOwnership = new WeakMap<DocumentRuntimeRequest, EncodedPointChanges>();
  readonly #receiver: boolean;
  #identity: ExecutorIdentity | null = null;
  #revision: number | null = null;
  #unlockOperation: number | null = null;

  public constructor(receiver = false) {
    this.#receiver = receiver;
  }

  public clear(): void {
    this.#points.clear();
    this.#lengths.clear();
    this.#retired.clear();
    this.#retiredBytes = 0;
    this.#identity = null;
    this.#revision = null;
    this.#unlockOperation = null;
  }

  public get instrumentation() {
    return { retiredPointBytes: this.#retiredBytes, retiredPointElements: this.#retired.size };
  }

  public encoder(request: DocumentRuntimeRequest): (element: InkElementV1) => boolean | "retired" {
    const valid =
      "baseModelRevision" in request &&
      request.baseModelRevision !== null &&
      this.#matches(request.baseModelRevision, "identity" in request ? request.identity : request);
    const encoded: EncodedPointChanges = {
      points: new Map(),
      lengths: new Map(),
      ownedPoints: new Set(),
      removedIds: "removedIds" in request ? [...(request.removedIds ?? [])] : [],
    };
    this.#encodedOwnership.set(request, encoded);
    return (element) => {
      if (element.kind === "stroke") encoded.lengths.set(element.id, element.points.length);
      if (
        element.kind !== "stroke" ||
        (!isStoredStroke(element) && !createSampleCopyProof(element.points).eligible)
      ) {
        encoded.points.set(element.id, null);
        return false;
      }
      encoded.points.set(element.id, element.points);
      if (isStoredStroke(element)) encoded.ownedPoints.add(element.points);
      if (!valid || !ownsImmutableSamples(element)) return false;
      if (this.#points.get(element.id) === element.points) return true;
      return this.#retired.get(element.id)?.points === element.points ? "retired" : false;
    };
  }

  public resolver(revision: number | null, identity: ExecutorIdentity) {
    return (id: string, retired = false): StrokeSamplesV1 => {
      const points = retired ? this.#retired.get(id)?.points : this.#points.get(id);
      if (revision === null || !this.#matches(revision, identity) || points === undefined) {
        throw new RangeError("Stroke point reference does not match the acknowledged model.");
      }
      return points;
    };
  }

  public stageUnlock(batch: UnlockRuntimeBatch): void {
    if (batch.batchIndex === 0) {
      this.clear();
      this.#identity = batch.identity;
      this.#unlockOperation = batch.identity.operationId;
    }
    if (this.#unlockOperation !== batch.identity.operationId) return;
    this.#adopt(batch.elements);
  }

  public accept(request: DocumentRuntimeRequest, result: DocumentRuntimeResult): void {
    if (result.type === "unlock-success" && request.type === "unlock") {
      if (result.snapshot.elementCount === 0) {
        this.clear();
        this.#identity = request.identity;
        this.#revision = result.snapshot.revision;
      } else if (this.#unlockOperation === request.identity.operationId) {
        this.#revision = result.snapshot.revision;
        this.#unlockOperation = null;
      }
      return;
    }
    if (result.type !== "export-success" && result.type !== "model-sync-success") return;
    if (!("baseModelRevision" in request)) return;
    if (request.baseModelRevision === null) this.clear();
    else if (
      !this.#matches(request.baseModelRevision, "identity" in request ? request.identity : request)
    ) {
      this.clear();
    }
    this.#identity = "identity" in request ? request.identity : request;
    this.#revision = request.modelRevision;
    if (this.#receiver) {
      if ("snapshot" in request) this.#adopt(request.snapshot.elements);
      else {
        for (const id of request.removedIds ?? []) this.#retire(id);
        this.#adopt(request.changedElements ?? []);
      }
    } else this.#adoptEncoded(request);
  }

  #adoptEncoded(request: DocumentRuntimeRequest): void {
    const encoded = this.#encodedOwnership.get(request);
    this.#encodedOwnership.delete(request);
    if (encoded === undefined) {
      this.#points.clear();
      this.#lengths.clear();
      this.#retired.clear();
      this.#retiredBytes = 0;
      return;
    }
    for (const id of encoded.removedIds) this.#retire(id);
    for (const [id, points] of encoded.points) {
      this.#removeRetired(id);
      const length = encoded.lengths.get(id);
      if (length === undefined) this.#lengths.delete(id);
      else this.#lengths.set(id, length);
      if (
        points === null ||
        (!encoded.ownedPoints.has(points) && !isImmutableStrokeSampleSource(points))
      )
        this.#points.delete(id);
      else this.#points.set(id, points);
    }
  }

  #matches(revision: number, identity: ExecutorIdentity): boolean {
    return (
      this.#revision === revision &&
      this.#identity?.sessionId === identity.sessionId &&
      this.#identity.workerEpoch === identity.workerEpoch
    );
  }

  #adopt(elements: readonly InkElementV1[]): void {
    for (const element of elements) {
      this.#removeRetired(element.id);
      if (element.kind === "stroke") this.#lengths.set(element.id, element.points.length);
      else this.#lengths.delete(element.id);
      if (element.kind === "stroke" && (this.#receiver || ownsImmutableSamples(element))) {
        this.#points.set(element.id, element.points);
      } else this.#points.delete(element.id);
    }
  }

  #retire(id: string): void {
    const length = this.#lengths.get(id);
    const points = this.#points.get(id);
    this.#points.delete(id);
    this.#lengths.delete(id);
    if (length === undefined) return;
    this.#removeRetired(id);
    const bytes = 128 + id.length * 2 + length * Float64Array.BYTES_PER_ELEMENT;
    if (bytes > MAX_RETIRED_BYTES) return;
    while (
      this.#retiredBytes + bytes > MAX_RETIRED_BYTES ||
      this.#retired.size >= MAX_RETIRED_ELEMENTS
    ) {
      this.#removeRetired(this.#retired.keys().next().value!);
    }
    // Size-only entries keep eviction identical when the sender lacks immutable ownership.
    this.#retired.set(id, { points, bytes });
    this.#retiredBytes += bytes;
  }

  #removeRetired(id: string): void {
    const entry = this.#retired.get(id);
    if (entry === undefined) return;
    this.#retired.delete(id);
    this.#retiredBytes -= entry.bytes;
  }
}

function ownsImmutableSamples(element: InkElementV1): boolean {
  return (
    element.kind === "stroke" &&
    (isStoredStroke(element) || isImmutableStrokeSampleSource(element.points))
  );
}
