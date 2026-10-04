import type { InkSnapshotV1, StrokeSamplesV1 } from "../../../domain/schema/public";
import type { ClipboardResult, PastePlan } from "../../clipboard/types";
import type { ExportFailure, ExportSuccess } from "../protocol";
import {
  packClipboardText,
  type PackedDecodedClipboard,
  type PackedClipboardText,
  unpackClipboardWriteResult,
  unpackClipboardWriteResultChunked,
  unpackDecodedClipboardResult,
  unpackDecodedClipboardResultChunked,
} from "./clipboard-text-wire";
import { packClipboardPayload } from "./clipboard-wire-payload";
import {
  packElements,
  packValidatedElements,
  packElementsChunked,
  type PackedElements,
  type RuntimeWireSliceOptions,
  unpackElements,
  unpackValidatedElements,
} from "./element-wire-codec";
import { copyElementsFromRuntime } from "./runtime-elements";
import type {
  DecodeClipboardRuntimeSuccess,
  DocumentRuntimeRequest,
  DocumentRuntimeResult,
  EncodeClipboardRuntimeSuccess,
  PlanClipboardPasteRuntimeSuccess,
  UnlockRuntimeBatch,
} from "./types";
import { assertUnlockBatchWireLimits } from "./unlock-batch-limits";
import {
  assertClipboardElementWireLimits,
  assertDocumentElementWireLimits,
} from "./packed-element-wire-limits";
import {
  decodeModelSyncRequest,
  encodeModelSyncRequest,
  encodeModelSyncRequestChunked,
  type ModelSyncWireRequest,
} from "./model-sync-wire";
import { isRuntimeWireRequestType, isRuntimeWireResultType } from "./wire-message-types";
import {
  decodeUnlockRequest,
  encodeUnlockRequest,
  isUnlockPurposeIdentity,
  type UnlockWireRequest,
} from "./unlock-request-wire";
import {
  adoptExportSuccess,
  encodeExportSuccess,
  encodeExportSuccessChunked,
  type ExportSuccessWireResult,
} from "./export-output-wire";
import { adoptOwnedSvgOutput, adoptOwnedSvgOutputSync } from "../../scheduling/owned-svg-output";
import { isDocumentIntegrityManifest } from "../../serialization/document-integrity-manifest";
import { assertScenePathIds } from "./scene-path-limits";

export type { RuntimeWireSliceOptions } from "./element-wire-codec";
interface FullExportWireRequest extends Omit<
  Extract<DocumentRuntimeRequest, { type: "export-full" }>,
  "snapshot" | "type"
> {
  readonly snapshot: Omit<InkSnapshotV1, "elements"> & { readonly elements: PackedElements };
  readonly type: "export-full-wire";
}

interface IncrementalExportWireRequest extends Omit<
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
          | "unlock";
      }
    >
  | FullExportWireRequest
  | IncrementalExportWireRequest
  | ModelSyncWireRequest
  | UnlockWireRequest;

type PackedPastePlan = Omit<PastePlan, "elements"> & { readonly elements: PackedElements };

interface EncodeClipboardWireResult extends Omit<EncodeClipboardRuntimeSuccess, "result" | "type"> {
  readonly result: ClipboardResult<PackedClipboardText>;
  readonly type: "clipboard-encode-success-wire";
}

interface DecodeClipboardWireResult extends Omit<DecodeClipboardRuntimeSuccess, "result" | "type"> {
  readonly result: ClipboardResult<PackedDecodedClipboard>;
  readonly type: "clipboard-decode-success-wire";
}

interface PlanClipboardPasteWireResult extends Omit<
  PlanClipboardPasteRuntimeSuccess,
  "result" | "type"
> {
  readonly result: ClipboardResult<PackedPastePlan>;
  readonly type: "clipboard-plan-paste-success-wire";
}

export type DocumentRuntimeWireResult =
  | Exclude<
      DocumentRuntimeResult,
      | DecodeClipboardRuntimeSuccess
      | EncodeClipboardRuntimeSuccess
      | ExportFailure
      | ExportSuccess
      | PlanClipboardPasteRuntimeSuccess
    >
  | DecodeClipboardWireResult
  | EncodeClipboardWireResult
  | ExportFailure
  | ExportSuccessWireResult
  | PlanClipboardPasteWireResult;

export interface StructuredTransfer<T> {
  readonly transfer: readonly Transferable[];
  readonly value: T;
}

export interface DocumentRuntimeWireUnlockBatch {
  readonly batchIndex: number;
  readonly derivations: UnlockRuntimeBatch["derivations"];
  readonly elements: PackedElements;
  readonly identity: UnlockRuntimeBatch["identity"];
}

export function encodeRuntimeRequest(
  request: DocumentRuntimeRequest,
): StructuredTransfer<DocumentRuntimeWireRequest> {
  if (request.type === "model-sync-full" || request.type === "model-sync-incremental") {
    return encodeModelSyncRequest(request);
  }
  if (request.type === "export-full") {
    const packed = packElements(request.snapshot.elements);
    return encodeFullExportRequest(request, packed);
  }
  if (request.type === "export-incremental") {
    const { changedElements, ...identity } = request;
    const packed = packElements(changedElements ?? []);
    return encodeIncrementalExportRequest(identity, changedElements, packed);
  }
  if (request.type === "unlock") return encodeUnlockRequest(request);
  return { transfer: [], value: request };
}

export async function encodeRuntimeRequestChunked(
  request: DocumentRuntimeRequest,
  options: RuntimeWireSliceOptions,
): Promise<StructuredTransfer<DocumentRuntimeWireRequest>> {
  options.signal.throwIfAborted();
  if (request.type === "model-sync-full" || request.type === "model-sync-incremental") {
    return encodeModelSyncRequestChunked(request, options);
  }
  if (request.type === "export-full") {
    const packed = await packElementsChunked(request.snapshot.elements, options);
    return encodeFullExportRequest(request, packed);
  }
  if (request.type === "export-incremental") {
    const { changedElements, ...identity } = request;
    const packed = await packElementsChunked(changedElements ?? [], options);
    return encodeIncrementalExportRequest(identity, changedElements, packed);
  }
  return encodeRuntimeRequest(request);
}

function encodeFullExportRequest(
  request: Extract<DocumentRuntimeRequest, { type: "export-full" }>,
  packed: PackedElements,
): StructuredTransfer<FullExportWireRequest> {
  return {
    transfer: buffersAsTransferables(packed.pointBuffers),
    value: {
      ...request,
      snapshot: { ...request.snapshot, elements: packed },
      type: "export-full-wire",
    },
  };
}

function encodeIncrementalExportRequest(
  request: Omit<Extract<DocumentRuntimeRequest, { type: "export-incremental" }>, "changedElements">,
  changedElements: readonly unknown[] | undefined,
  packed: PackedElements,
): StructuredTransfer<IncrementalExportWireRequest> {
  return {
    transfer: buffersAsTransferables(packed.pointBuffers),
    value: {
      ...request,
      ...(changedElements === undefined ? {} : { changedElements: packed }),
      type: "export-incremental-wire",
    },
  };
}

export function decodeRuntimeRequest(
  request: unknown,
  resolvePoints?: (id: string) => StrokeSamplesV1,
): DocumentRuntimeRequest {
  if (!isDocumentRuntimeWireRequest(request)) {
    throw new TypeError("Worker request does not match the runtime wire protocol.");
  }
  if (request.type === "unlock") return decodeUnlockRequest(request);
  if (request.type === "prepare-scene-paths") {
    assertScenePathIds(request.ids);
    if (request.streamProgress !== undefined && typeof request.streamProgress !== "boolean")
      throw new TypeError("Invalid scene preparation progress mode.");
    if (!Number.isSafeInteger(request.basisRevision) || request.basisRevision < 0)
      throw new TypeError("Invalid scene preparation revision.");
  }
  if (request.type === "export-full-wire") {
    assertDocumentElementWireLimits(request.snapshot.elements);
    return {
      ...request,
      snapshot: { ...request.snapshot, elements: unpackElements(request.snapshot.elements) },
      type: "export-full",
    };
  }
  if (request.type === "model-sync-full-wire" || request.type === "model-sync-incremental-wire") {
    return decodeModelSyncRequest(request, resolvePoints);
  }
  if (request.type === "export-incremental-wire") {
    const { changedElements, ...identity } = request;
    if (changedElements !== undefined) assertDocumentElementWireLimits(changedElements);
    return {
      ...identity,
      ...(changedElements === undefined
        ? {}
        : { changedElements: unpackElements(changedElements, resolvePoints) }),
      type: "export-incremental",
    };
  }
  return request;
}

export function encodeRuntimeResult(
  result: DocumentRuntimeResult,
): StructuredTransfer<DocumentRuntimeWireResult> {
  if (result.type === "clipboard-encode-success") return encodeClipboardResult(result);
  if (result.type === "clipboard-decode-success") return decodeClipboardResult(result);
  if (result.type === "clipboard-plan-paste-success") return encodePastePlanResult(result);
  if (result.type !== "export-success") return { transfer: [], value: result };
  return encodeExportSuccess(result);
}

export async function encodeRuntimeResultChunked(
  result: DocumentRuntimeResult,
  options: RuntimeWireSliceOptions,
): Promise<StructuredTransfer<DocumentRuntimeWireResult>> {
  options.signal.throwIfAborted();
  if (result.type !== "export-success") {
    return encodeRuntimeResult(result);
  }
  return encodeExportSuccessChunked(result, options);
}

export function decodeRuntimeResult(result: unknown): DocumentRuntimeResult {
  if (!isDocumentRuntimeWireResult(result)) {
    throw new TypeError("Worker result does not match the runtime wire protocol.");
  }
  if (result.type === "export-success-wire") {
    const trusted = adoptOwnedSvgOutputSync(result.output, result.outputHash);
    return adoptExportSuccess(result, trusted);
  }
  if (result.type === "clipboard-encode-success-wire") {
    return {
      ...result,
      result: unpackClipboardWriteResult(result.result),
      type: "clipboard-encode-success",
    };
  }
  if (result.type === "clipboard-decode-success-wire") {
    return {
      ...result,
      result: unpackDecodedClipboardResult(result.result),
      type: "clipboard-decode-success",
    };
  }
  if (result.type === "clipboard-plan-paste-success-wire") {
    return {
      ...result,
      result: unpackPastePlan(result.result),
      type: "clipboard-plan-paste-success",
    };
  }
  return result;
}

export async function decodeRuntimeResultChunked(
  result: unknown,
  options: RuntimeWireSliceOptions,
): Promise<DocumentRuntimeResult> {
  options.signal.throwIfAborted();
  if (!isDocumentRuntimeWireResult(result)) {
    throw new TypeError("Worker result does not match the runtime wire protocol.");
  }
  if (result.type === "export-success-wire") {
    const trusted = await adoptOwnedSvgOutput(result.output, result.outputHash, options);
    return adoptExportSuccess(result, trusted);
  }
  if (result.type === "clipboard-encode-success-wire") {
    return {
      ...result,
      result: await unpackClipboardWriteResultChunked(result.result, options),
      type: "clipboard-encode-success",
    };
  }
  if (result.type === "clipboard-decode-success-wire") {
    return {
      ...result,
      result: await unpackDecodedClipboardResultChunked(result.result, options),
      type: "clipboard-decode-success",
    };
  }
  return decodeRuntimeResult(result);
}

function encodeClipboardResult(
  result: EncodeClipboardRuntimeSuccess,
): StructuredTransfer<EncodeClipboardWireResult> {
  if (!result.result.ok) {
    return failedClipboardTransfer(result.identity, result.result, "clipboard-encode-success-wire");
  }
  const text = packClipboardText(result.result.value);
  return {
    transfer: [text.canonicalText.buffer as ArrayBuffer],
    value: {
      identity: result.identity,
      result: { ok: true, value: text },
      type: "clipboard-encode-success-wire",
    },
  };
}

function decodeClipboardResult(
  result: DecodeClipboardRuntimeSuccess,
): StructuredTransfer<DecodeClipboardWireResult> {
  if (!result.result.ok) {
    return failedClipboardTransfer(result.identity, result.result, "clipboard-decode-success-wire");
  }
  const text = packClipboardText(result.result.value);
  const payload = packClipboardPayload(result.result.value.payload);
  return {
    transfer: [
      text.canonicalText.buffer as ArrayBuffer,
      ...buffersAsTransferables(payload.pointBuffers),
    ],
    value: {
      identity: result.identity,
      result: {
        ok: true,
        value: { ...text, payload, source: result.result.value.source },
      },
      type: "clipboard-decode-success-wire",
    },
  };
}

function failedClipboardTransfer<TType extends string>(
  identity: DecodeClipboardRuntimeSuccess["identity"],
  result: Extract<ClipboardResult<unknown>, { ok: false }>,
  type: TType,
) {
  return { transfer: [], value: { identity, result, type } };
}

function encodePastePlanResult(
  result: PlanClipboardPasteRuntimeSuccess,
): StructuredTransfer<PlanClipboardPasteWireResult> {
  if (!result.result.ok) {
    return {
      transfer: [],
      value: {
        identity: result.identity,
        result: result.result,
        type: "clipboard-plan-paste-success-wire",
      },
    };
  }
  const elements = packElements(result.result.value.elements);
  return {
    transfer: buffersAsTransferables(elements.pointBuffers),
    value: {
      ...result,
      result: { ok: true, value: { ...result.result.value, elements } },
      type: "clipboard-plan-paste-success-wire",
    },
  };
}

function unpackPastePlan(result: ClipboardResult<PackedPastePlan>): ClipboardResult<PastePlan> {
  if (!result.ok) return result;
  assertClipboardElementWireLimits(result.value.elements);
  const elements = copyElementsFromRuntime(unpackElements(result.value.elements));
  return { ok: true, value: { ...result.value, elements } };
}

export function encodeUnlockBatch(
  batch: UnlockRuntimeBatch,
): StructuredTransfer<DocumentRuntimeWireUnlockBatch> {
  const elements = packValidatedElements(batch.elements, batch.derivations);
  return {
    transfer: buffersAsTransferables(elements.pointBuffers),
    value: {
      batchIndex: batch.batchIndex,
      derivations: batch.derivations,
      elements,
      identity: batch.identity,
    },
  };
}

export function decodeUnlockBatch(batch: unknown): UnlockRuntimeBatch {
  if (!isDocumentRuntimeWireUnlockBatch(batch)) {
    throw new TypeError("Worker unlock batch does not match the runtime wire protocol.");
  }
  assertUnlockBatchWireLimits(batch.elements);
  return { ...batch, elements: unpackValidatedElements(batch.elements, batch.derivations) };
}

export function isDocumentRuntimeWireRequest(value: unknown): value is DocumentRuntimeWireRequest {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  return isRuntimeWireRequestType(value.type);
}

export function isDocumentRuntimeWireResult(value: unknown): value is DocumentRuntimeWireResult {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (!isRuntimeWireResultType(value.type)) return false;
  if (value.type === "unlock-success") {
    return (
      typeof value.lockedHeight === "number" &&
      Number.isFinite(value.lockedHeight) &&
      value.lockedHeight > 0 &&
      typeof value.requiresCanonicalRewrite === "boolean" &&
      typeof value.sourceVersion === "number" &&
      Number.isSafeInteger(value.sourceVersion) &&
      value.sourceVersion >= 0 &&
      value.sourceVersion <= 1
    );
  }
  if (value.type !== "export-success-wire") return true;
  return (
    isDocumentIntegrityManifest(value.integrityManifest) &&
    value.output instanceof Uint8Array &&
    value.output.buffer instanceof ArrayBuffer &&
    value.output.byteOffset === 0 &&
    value.output.byteLength === value.output.buffer.byteLength
  );
}

export function isDocumentRuntimeWireUnlockBatch(
  value: unknown,
): value is DocumentRuntimeWireUnlockBatch {
  return (
    isRecord(value) &&
    typeof value.batchIndex === "number" &&
    Number.isSafeInteger(value.batchIndex) &&
    value.batchIndex >= 0 &&
    Array.isArray(value.derivations) &&
    isUnlockPurposeIdentity(value.identity) &&
    isPackedElements(value.elements)
  );
}

function buffersAsTransferables(buffers: readonly Float64Array[]): Transferable[] {
  return buffers.map((buffer) => buffer.buffer as ArrayBuffer);
}

function isPackedElements(value: unknown): value is PackedElements {
  return isRecord(value) && Array.isArray(value.records) && Array.isArray(value.pointBuffers);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
