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
  readonly ownedPoints: Set<StrokeSamplesV1>;
  readonly removedIds: readonly string[];
}

/** Holds only the acknowledged model; failed or superseded requests never publish references. */
export class ModelPointReferences {
  readonly #points = new Map<string, StrokeSamplesV1>();
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
    this.#identity = null;
    this.#revision = null;
    this.#unlockOperation = null;
  }

  public encoder(request: DocumentRuntimeRequest): (element: InkElementV1) => boolean {
    const valid =
      "baseModelRevision" in request &&
      request.baseModelRevision !== null &&
      this.#matches(request.baseModelRevision, "identity" in request ? request.identity : request);
    const encoded: EncodedPointChanges = {
      points: new Map(),
      ownedPoints: new Set(),
      removedIds: "removedIds" in request ? [...(request.removedIds ?? [])] : [],
    };
    this.#encodedOwnership.set(request, encoded);
    return (element) => {
      if (
        element.kind !== "stroke" ||
        (!isStoredStroke(element) && !createSampleCopyProof(element.points).eligible)
      ) {
        encoded.points.set(element.id, null);
        return false;
      }
      encoded.points.set(element.id, element.points);
      if (isStoredStroke(element)) encoded.ownedPoints.add(element.points);
      return (
        valid && ownsImmutableSamples(element) && this.#points.get(element.id) === element.points
      );
    };
  }

  public resolver(revision: number | null, identity: ExecutorIdentity) {
    return (id: string): StrokeSamplesV1 => {
      const points = this.#points.get(id);
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
        for (const id of request.removedIds ?? []) this.#points.delete(id);
        this.#adopt(request.changedElements ?? []);
      }
    } else this.#adoptEncoded(request);
  }

  #adoptEncoded(request: DocumentRuntimeRequest): void {
    const encoded = this.#encodedOwnership.get(request);
    this.#encodedOwnership.delete(request);
    if (encoded === undefined) {
      this.#points.clear();
      return;
    }
    for (const id of encoded.removedIds) this.#points.delete(id);
    for (const [id, points] of encoded.points) {
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
      if (element.kind === "stroke" && (this.#receiver || ownsImmutableSamples(element))) {
        this.#points.set(element.id, element.points);
      } else this.#points.delete(element.id);
    }
  }
}

function ownsImmutableSamples(element: InkElementV1): boolean {
  return (
    element.kind === "stroke" &&
    (isStoredStroke(element) || isImmutableStrokeSampleSource(element.points))
  );
}
