import type { InkSnapshotV1 } from "../../../domain/schema/public";
import { assertDocumentElementWireLimits } from "./packed-element-wire-limits";
import {
  packElements,
  packElementsChunked,
  type PackedElements,
  type RuntimeWireSliceOptions,
  unpackElements,
} from "./element-wire-codec";
import type {
  FullModelSyncRuntimeRequest,
  IncrementalModelSyncRuntimeRequest,
  ModelSyncRuntimeRequest,
} from "./types";

interface FullModelSyncWireRequest extends Omit<FullModelSyncRuntimeRequest, "snapshot" | "type"> {
  readonly snapshot: Omit<InkSnapshotV1, "elements"> & { readonly elements: PackedElements };
  readonly type: "model-sync-full-wire";
}

interface IncrementalModelSyncWireRequest extends Omit<
  IncrementalModelSyncRuntimeRequest,
  "changedElements" | "type"
> {
  readonly changedElements?: PackedElements;
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
  if (request.type === "model-sync-full") {
    return encodeFull(request, packElements(request.snapshot.elements));
  }
  return encodeIncremental(request, packElements(request.changedElements ?? []));
}

export async function encodeModelSyncRequestChunked(
  request: ModelSyncRuntimeRequest,
  options: RuntimeWireSliceOptions,
): Promise<WireTransfer<ModelSyncWireRequest>> {
  const elements =
    request.type === "model-sync-full"
      ? request.snapshot.elements
      : (request.changedElements ?? []);
  const packed = await packElementsChunked(elements, options);
  return request.type === "model-sync-full"
    ? encodeFull(request, packed)
    : encodeIncremental(request, packed);
}

export function decodeModelSyncRequest(request: ModelSyncWireRequest): ModelSyncRuntimeRequest {
  if (request.type === "model-sync-full-wire") {
    assertDocumentElementWireLimits(request.snapshot.elements);
    return {
      ...request,
      snapshot: { ...request.snapshot, elements: unpackElements(request.snapshot.elements) },
      type: "model-sync-full",
    };
  }
  const { changedElements, ...identity } = request;
  if (changedElements !== undefined) assertDocumentElementWireLimits(changedElements);
  return {
    ...identity,
    ...(changedElements === undefined ? {} : { changedElements: unpackElements(changedElements) }),
    type: "model-sync-incremental",
  };
}

function encodeFull(
  request: FullModelSyncRuntimeRequest,
  elements: PackedElements,
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
  elements: PackedElements,
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

function buffers(elements: PackedElements): Transferable[] {
  return elements.pointBuffers.map((buffer) => buffer.buffer as ArrayBuffer);
}
