import type { InkSnapshotV1 } from "../../../../domain/schema/public";
import {
  packElements,
  packElementsChunked,
  type RuntimeWireSliceOptions,
} from "./element-wire-codec";
import type {
  FullModelSyncRuntimeRequest,
  IncrementalModelSyncRuntimeRequest,
  ModelSyncRuntimeRequest,
} from "../types";
import {
  MODEL_SYNC_POINT_BUFFER_TRANSFER_LIMIT,
  prepareModelSyncPointArenaSteps,
  type PackedModelSyncElements,
} from "./model-sync-point-arena";
import {
  completeSerializationSteps,
  consumeSerializationSteps,
} from "../../../serialization/output/serialization-model-preparation";

interface FullModelSyncWireRequest extends Omit<FullModelSyncRuntimeRequest, "snapshot" | "type"> {
  readonly snapshot: Omit<InkSnapshotV1, "elements"> & {
    readonly elements: PackedModelSyncElements;
  };
  readonly type: "model-sync-full-wire";
}

interface IncrementalModelSyncWireRequest extends Omit<
  IncrementalModelSyncRuntimeRequest,
  "changedElements" | "type"
> {
  readonly changedElements?: PackedModelSyncElements;
  readonly type: "model-sync-incremental-wire";
}

export type ModelSyncWireRequest = FullModelSyncWireRequest | IncrementalModelSyncWireRequest;

interface WireTransfer<T> {
  readonly transfer: readonly Transferable[];
  readonly value: T;
}

export function encodeModelSyncRequest(
  request: ModelSyncRuntimeRequest,
): WireTransfer<ModelSyncWireRequest> {
  const elements =
    request.type === "model-sync-full"
      ? request.snapshot.elements
      : (request.changedElements ?? []);
  const packed = completeSerializationSteps(
    prepareModelSyncPointArenaSteps(packElements(elements)),
  );
  if (request.type === "model-sync-full") {
    return encodeFull(request, packed);
  }
  return encodeIncremental(request, packed);
}

export async function encodeModelSyncRequestChunked(
  request: ModelSyncRuntimeRequest,
  options: RuntimeWireSliceOptions,
): Promise<WireTransfer<ModelSyncWireRequest>> {
  const elements =
    request.type === "model-sync-full"
      ? request.snapshot.elements
      : (request.changedElements ?? []);
  const copied = await packElementsChunked(elements, options);
  const packed =
    copied.pointBuffers.length <= MODEL_SYNC_POINT_BUFFER_TRANSFER_LIMIT
      ? copied
      : await consumeSerializationSteps(prepareModelSyncPointArenaSteps(copied), options);
  return request.type === "model-sync-full"
    ? encodeFull(request, packed)
    : encodeIncremental(request, packed);
}

function encodeFull(
  request: FullModelSyncRuntimeRequest,
  elements: PackedModelSyncElements,
): WireTransfer<FullModelSyncWireRequest> {
  return {
    transfer: buffers(elements),
    value: {
      ...request,
      snapshot: { ...request.snapshot, elements },
      type: "model-sync-full-wire",
    },
  };
}

function encodeIncremental(
  request: IncrementalModelSyncRuntimeRequest,
  elements: PackedModelSyncElements,
): WireTransfer<IncrementalModelSyncWireRequest> {
  const { changedElements, ...identity } = request;
  return {
    transfer: buffers(elements),
    value: {
      ...identity,
      ...(changedElements === undefined ? {} : { changedElements: elements }),
      type: "model-sync-incremental-wire",
    },
  };
}

function buffers(elements: PackedModelSyncElements): Transferable[] {
  if ("format" in elements)
    return [elements.pointArena.buffer as ArrayBuffer, elements.pointLengths.buffer as ArrayBuffer];
  return elements.pointBuffers.map((buffer) => buffer.buffer as ArrayBuffer);
}
