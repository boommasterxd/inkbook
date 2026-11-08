import type { InkSnapshotV1, StrokeSamplesV1 } from "../../../../domain/schema/public";
import { unpackElementsSteps, type PackedElements } from "./element-wire-codec";
import { documentElementWireLimitSteps } from "./packed-element-wire-limits";
import { assertScenePathRequest } from "../model/scene-path-limits";
import { isRuntimeWireRequestType } from "./wire-message-types";
import { decodeUnlockRequest, type UnlockWireRequest } from "./unlock-request-wire";
import type { ModelSyncWireRequest } from "./model-sync-wire";
import { expandModelSyncPointArenaSteps } from "./model-sync-point-arena";
import type { DocumentRuntimeRequest, RuntimeSliceContext } from "../types";
import { consumeSerializationSteps } from "../../../serialization/output/serialization-model-preparation";
import { assertImportInkRequest } from "./ink-import-wire";
import {
  decodeExportGeometryRequest,
  type ExportGeometryWireRequest,
} from "./export-geometry-wire";

export interface FullExportWireRequest extends Omit<
  Extract<DocumentRuntimeRequest, { type: "export-full" }>,
  "snapshot" | "type"
> {
  readonly snapshot: Omit<InkSnapshotV1, "elements"> & { readonly elements: PackedElements };
  readonly type: "export-full-wire";
}

export interface IncrementalExportWireRequest extends Omit<
  Extract<DocumentRuntimeRequest, { type: "export-incremental" }>,
  "changedElements" | "type"
> {
  readonly changedElements?: PackedElements;
  readonly type: "export-incremental-wire";
}

export type DocumentRuntimeWireRequest =
  | Exclude<
      DocumentRuntimeRequest,
      {
        type:
          | "export-full"
          | "export-incremental"
          | "model-sync-full"
          | "model-sync-incremental"
          | "prepare-export-geometry"
          | "unlock";
      }
    >
  | FullExportWireRequest
  | ExportGeometryWireRequest
  | IncrementalExportWireRequest
  | ModelSyncWireRequest
  | UnlockWireRequest;

export function decodeRuntimeRequestChunked(
  request: unknown,
  context: RuntimeSliceContext,
  resolvePoints?: (id: string, retired?: boolean) => StrokeSamplesV1,
): Promise<DocumentRuntimeRequest> {
  return consumeSerializationSteps(decodeRuntimeRequestSteps(request, resolvePoints), context);
}

function* decodeRuntimeRequestSteps(
  request: unknown,
  resolvePoints?: (id: string, retired?: boolean) => StrokeSamplesV1,
): Generator<void, DocumentRuntimeRequest> {
  if (!isDocumentRuntimeWireRequest(request))
    throw new TypeError("Worker request does not match the runtime wire protocol.");
  if (request.type === "unlock") return decodeUnlockRequest(request);
  if (request.type === "prepare-export-geometry") return decodeExportGeometryRequest(request);
  if (request.type === "import-ink") assertImportInkRequest(request);
  if (request.type === "prepare-scene-paths") {
    assertScenePathRequest(request);
    if (!Number.isSafeInteger(request.basisRevision) || request.basisRevision < 0)
      throw new TypeError("Invalid scene preparation revision.");
  }
  if (request.type === "export-full-wire" || request.type === "model-sync-full-wire") {
    const { snapshot, ...identity } = request;
    const type = request.type === "export-full-wire" ? "export-full" : "model-sync-full";
    const header = {
      ...snapshot,
      page: { ...snapshot.page, background: { ...snapshot.page.background } },
    };
    const packed =
      request.type === "model-sync-full-wire"
        ? yield* expandModelSyncPointArenaSteps(header.elements)
        : (header.elements as PackedElements);
    yield* documentElementWireLimitSteps(packed);
    const elements = yield* unpackElementsSteps(packed);
    return {
      ...identity,
      snapshot: { ...header, elements },
      type,
    } as DocumentRuntimeRequest;
  }
  if (
    request.type === "export-incremental-wire" ||
    request.type === "model-sync-incremental-wire"
  ) {
    const { changedElements, ...identity } = request;
    const type =
      request.type === "export-incremental-wire" ? "export-incremental" : "model-sync-incremental";
    let elements;
    if (changedElements !== undefined) {
      const packed =
        request.type === "model-sync-incremental-wire"
          ? yield* expandModelSyncPointArenaSteps(changedElements)
          : (changedElements as PackedElements);
      yield* documentElementWireLimitSteps(packed);
      elements = yield* unpackElementsSteps(packed, resolvePoints);
    }
    return {
      ...identity,
      ...(elements === undefined ? {} : { changedElements: elements }),
      type,
    } as DocumentRuntimeRequest;
  }
  return request;
}

/** Only identities and job-class fields are needed before bounded runtime admission. */
export function runtimeRequestAdmissionHeader(
  request: DocumentRuntimeWireRequest,
): DocumentRuntimeRequest {
  if (request.type === "export-full-wire" || request.type === "model-sync-full-wire")
    return {
      ...request,
      snapshot: { ...request.snapshot, elements: [] },
      type: request.type === "export-full-wire" ? "export-full" : "model-sync-full",
    } as DocumentRuntimeRequest;
  if (request.type === "export-incremental-wire" || request.type === "model-sync-incremental-wire")
    return {
      ...request,
      changedElements: [],
      type:
        request.type === "export-incremental-wire"
          ? "export-incremental"
          : "model-sync-incremental",
    } as DocumentRuntimeRequest;
  if (request.type === "unlock") return { identity: request.identity, input: "", type: "unlock" };
  if (request.type === "prepare-export-geometry")
    return { identity: request.identity, input: "", type: "prepare-export-geometry" };
  return request;
}

export function isDocumentRuntimeWireRequest(value: unknown): value is DocumentRuntimeWireRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    typeof value.type !== "string"
  )
    return false;
  return isRuntimeWireRequestType(value.type);
}
