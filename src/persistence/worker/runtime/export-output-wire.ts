import type { ExportSuccess } from "../protocol";
import type { RuntimeWireSliceOptions } from "./element-wire-codec";
import { exclusiveTransferBytes } from "./transferable-bytes";

export const EXPORT_OUTPUT_WIRE_FORMAT = "transferred-utf8" as const;

export interface ExportSuccessWireResult extends Omit<ExportSuccess, "output" | "type"> {
  readonly output: Uint8Array<ArrayBuffer>;
  readonly type: "export-success-wire";
}

export interface ExportWireTransfer {
  readonly transfer: readonly Transferable[];
  readonly value: ExportSuccessWireResult;
}

export function encodeExportSuccess(result: ExportSuccess): ExportWireTransfer {
  const bytes = exclusiveTransferBytes(
    typeof result.output === "string" ? new TextEncoder().encode(result.output) : result.output,
  );
  return {
    transfer: [bytes.buffer],
    value: { ...result, output: bytes, type: "export-success-wire" },
  };
}

export async function encodeExportSuccessChunked(
  result: ExportSuccess,
  options: RuntimeWireSliceOptions,
): Promise<ExportWireTransfer> {
  options.signal.throwIfAborted();
  await options.checkpoint();
  options.signal.throwIfAborted();
  return encodeExportSuccess(result);
}
