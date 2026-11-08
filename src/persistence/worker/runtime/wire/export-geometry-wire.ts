import { FILE_SCHEMA_LIMITS } from "../../../../domain/schema/public";
import type { ExportInterval } from "../../../../domain/export/export-pagination";
import { isNativeUint8Array } from "../../../serialization/transfer-array";
import { utf8ByteLengthWithinLimit } from "../../../scheduling/utf8-byte-length";
import { SafeStaticProof } from "../../../serialization/input/safe-static-proof";
import { consumeSerializationSteps } from "../../../serialization/output/serialization-model-preparation";
import type { RuntimeWireSliceOptions } from "./element-wire-codec";
import type { PrepareExportGeometryRequest } from "../types";
import {
  decodeUnlockRequest,
  encodeUnlockRequest,
  type UnlockWireRequest,
} from "./unlock-request-wire";

export interface ExportGeometryWireRequest extends Omit<UnlockWireRequest, "type"> {
  readonly type: "prepare-export-geometry";
}

export function assertExportGeometryRequest(request: PrepareExportGeometryRequest): void {
  const { identity, input } = request;
  if (
    typeof identity?.sessionId !== "string" ||
    identity.sessionId.length === 0 ||
    identity.sessionId.length > 256 ||
    !Number.isSafeInteger(identity.workerEpoch) ||
    identity.workerEpoch < 1 ||
    !Number.isSafeInteger(identity.operationId) ||
    identity.operationId < 0 ||
    identity.purpose !== "preflight" ||
    (typeof input !== "string" && !isNativeUint8Array(input)) ||
    (typeof input === "string" ? input.length : input.byteLength) >
      FILE_SCHEMA_LIMITS.totalInputBytes
  )
    throw new TypeError("Invalid or oversized export geometry request.");
}

export function encodeExportGeometryRequest(request: PrepareExportGeometryRequest) {
  assertExportGeometryRequest(request);
  const encoded = encodeUnlockRequest({ ...request, type: "unlock" });
  return {
    transfer: encoded.transfer,
    value: { ...encoded.value, type: "prepare-export-geometry" as const },
  };
}

export async function encodeExportGeometryRequestChunked(
  request: PrepareExportGeometryRequest,
  options: RuntimeWireSliceOptions,
) {
  assertExportGeometryRequest(request);
  const input =
    typeof request.input === "string"
      ? await consumeSerializationSteps(
          encodeInputSteps(request.input, request.safeStaticProof),
          options,
        )
      : request.input;
  options.signal.throwIfAborted();
  return encodeExportGeometryRequest({ ...request, input });
}

/** Owned evidence supplies an allocation hint; every code unit must still be encoded. */
function* encodeInputSteps(
  input: string,
  proof: SafeStaticProof | undefined,
): Generator<void, Uint8Array<ArrayBuffer>> {
  if (SafeStaticProof.isAuthentic(proof)) {
    const hinted = yield* encodeToLengthSteps(input, proof.totalBytes);
    if (hinted !== undefined) return hinted;
  }
  let total = 0;
  for (let offset = 0; offset < input.length;) {
    const end = chunkEnd(input, offset);
    const bytes = utf8ByteLengthWithinLimit(
      input.slice(offset, end),
      FILE_SCHEMA_LIMITS.totalInputBytes - total,
    );
    if (bytes === null) throw new RangeError("Export geometry input exceeds the file limit.");
    total += bytes;
    offset = end;
    yield;
  }
  const output = yield* encodeToLengthSteps(input, total);
  if (output === undefined) throw new Error("Export geometry encoding length changed.");
  return output;
}

function* encodeToLengthSteps(
  input: string,
  totalBytes: number,
): Generator<void, Uint8Array<ArrayBuffer> | undefined> {
  const output = new Uint8Array(totalBytes);
  const encoder = new TextEncoder();
  let written = 0;
  for (let offset = 0; offset < input.length;) {
    const end = chunkEnd(input, offset);
    const text = input.slice(offset, end);
    const result = encoder.encodeInto(text, output.subarray(written));
    if (result.read !== text.length) return undefined;
    written += result.written;
    offset = end;
    yield;
  }
  return written === totalBytes ? output : undefined;
}

function chunkEnd(input: string, offset: number): number {
  let end = Math.min(input.length, offset + 16 * 1024);
  const last = input.charCodeAt(end - 1);
  if (end < input.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return end;
}

export function decodeExportGeometryRequest(request: ExportGeometryWireRequest) {
  const decoded = decodeUnlockRequest({ ...request, type: "unlock" });
  const result: PrepareExportGeometryRequest = { ...decoded, type: "prepare-export-geometry" };
  assertExportGeometryRequest(result);
  return result;
}

export function* validateExportIntervalsSteps(
  value: unknown,
): Generator<void, readonly ExportInterval[] | undefined> {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > FILE_SCHEMA_LIMITS.elements) {
    throw new TypeError("Export geometry exceeds the element limit.");
  }
  for (const interval of value as unknown[]) {
    if (
      typeof interval !== "object" ||
      interval === null ||
      !("minY" in interval) ||
      !("maxY" in interval) ||
      typeof interval.minY !== "number" ||
      typeof interval.maxY !== "number" ||
      !Number.isFinite(interval.minY) ||
      !Number.isFinite(interval.maxY) ||
      interval.minY > interval.maxY
    ) {
      throw new TypeError("Export geometry requires finite ordered intervals.");
    }
    yield;
  }
  return value as ExportInterval[];
}
