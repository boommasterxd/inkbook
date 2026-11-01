import type { ImportInkRuntimeRequest, ImportInkRuntimeSuccess } from "../types";
import {
  adoptExportSuccess,
  encodeExportSuccess,
  type ExportSuccessWireResult,
} from "./export-output-wire";
import { adoptOwnedSvgOutput, adoptOwnedSvgOutputSync } from "../../../scheduling/owned-svg-output";
import type { RuntimeWireSliceOptions } from "./element-wire-codec";

const MAX_IMPORT_CHARACTERS = 16 * 1024 * 1024;

export interface ImportInkWireSuccess extends Omit<ImportInkRuntimeSuccess, "exported" | "type"> {
  readonly exported: ExportSuccessWireResult;
  readonly type: "import-ink-success-wire";
}

export function assertImportInkRequest(request: ImportInkRuntimeRequest): void {
  if (
    typeof request.input !== "string" ||
    request.input.length > MAX_IMPORT_CHARACTERS ||
    typeof request.legacyWriting !== "boolean" ||
    !Number.isSafeInteger(request.timestamp) ||
    request.timestamp < 0 ||
    typeof request.identity?.sessionId !== "string" ||
    request.identity.sessionId.length === 0 ||
    request.identity.sessionId.length > 256 ||
    !Number.isSafeInteger(request.identity.workerEpoch) ||
    request.identity.workerEpoch < 1 ||
    !Number.isSafeInteger(request.identity.operationId) ||
    request.identity.operationId < 0 ||
    request.identity.purpose !== "migration"
  )
    throw new TypeError("Invalid or oversized Ink import request.");
}

export function encodeImportInkSuccess(result: ImportInkRuntimeSuccess) {
  const exported = encodeExportSuccess(result.exported);
  return {
    transfer: exported.transfer,
    value: { ...result, exported: exported.value, type: "import-ink-success-wire" as const },
  };
}

export function decodeImportInkSuccess(result: ImportInkWireSuccess): ImportInkRuntimeSuccess {
  const trusted = adoptOwnedSvgOutputSync(result.exported.output, result.exported.outputHash);
  return {
    ...result,
    exported: adoptExportSuccess(result.exported, trusted),
    type: "import-ink-success",
  };
}

export async function decodeImportInkSuccessChunked(
  result: ImportInkWireSuccess,
  options: RuntimeWireSliceOptions,
): Promise<ImportInkRuntimeSuccess> {
  const trusted = await adoptOwnedSvgOutput(
    result.exported.output,
    result.exported.outputHash,
    options,
  );
  return {
    ...result,
    exported: adoptExportSuccess(result.exported, trusted),
    type: "import-ink-success",
  };
}

export function validImportInkDetails(value: Record<string, unknown>): boolean {
  return (
    typeof value.exported === "object" &&
    value.exported !== null &&
    "type" in value.exported &&
    value.exported.type === "export-success-wire" &&
    Array.isArray(value.warnings) &&
    value.warnings.length <= 100 &&
    value.warnings.every(
      (warning: unknown) => typeof warning === "string" && warning.length <= 4096,
    ) &&
    (value.transcript === undefined ||
      (typeof value.transcript === "string" && value.transcript.length <= 1024 * 1024))
  );
}
