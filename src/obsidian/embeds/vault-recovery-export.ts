import type {
  DocumentRuntimePort,
  DocumentRuntimeRequest,
  DocumentRuntimeResult,
} from "../../persistence/worker/runtime/public";

/** Decoded output is caller-owned; close the receipt before validation or host I/O. */
export async function runVaultRecoveryExport(
  executor: DocumentRuntimePort,
  request: Extract<DocumentRuntimeRequest, { type: "export-full" }>,
): Promise<DocumentRuntimeResult> {
  let result: DocumentRuntimeResult | undefined;
  try {
    result = await executor.execute(request);
    return result;
  } finally {
    if (result?.type === "export-success") {
      // Recovery and baseline restoration do not confirm an autosave generation.
      executor.acknowledgeExport?.(result, false);
    }
  }
}
