import { convertObsidianInk, ObsidianInkImportError } from "../../../import/obsidian-ink/convert";
import type { DocumentModelRuntime } from "./document-model";
import { RuntimeModelError } from "./runtime-model-error";
import { assertImportInkRequest } from "../wire/ink-import-wire";
import type {
  ImportInkRuntimeRequest,
  ImportInkRuntimeSuccess,
  RuntimeSliceContext,
} from "../types";

export async function runImportInkRequest(
  model: DocumentModelRuntime,
  request: ImportInkRuntimeRequest,
  context: RuntimeSliceContext,
  signal: AbortSignal,
): Promise<ImportInkRuntimeSuccess> {
  assertImportInkRequest(request);
  try {
    const converted = await convertObsidianInk(request.input, {
      checkpoint: context.checkpoint,
      signal,
      timestamp: request.timestamp,
      legacyWriting: request.legacyWriting,
    });
    signal.throwIfAborted();
    const exported = await model.export(
      {
        ...request.identity,
        baseModelRevision: null,
        exportGeneration: request.identity.operationId,
        modelRevision: converted.snapshot.revision,
        snapshot: converted.snapshot,
        type: "export-full",
      },
      context,
    );
    signal.throwIfAborted();
    if (!exported.ok) throw new RuntimeModelError(exported.code, exported.retryable);
    return {
      identity: request.identity,
      exported: {
        ...request.identity,
        exportGeneration: request.identity.operationId,
        modelRevision: converted.snapshot.revision,
        integrityManifest: exported.integrityManifest,
        output: exported.output,
        outputHash: exported.hash,
        totalBytes: exported.totalBytes,
        type: "export-success",
      },
      warnings: converted.warnings,
      warningCodes: converted.warningCodes,
      ...(converted.transcript === undefined ? {} : { transcript: converted.transcript }),
      type: "import-ink-success",
    };
  } catch (error) {
    if (error instanceof ObsidianInkImportError)
      throw new RuntimeModelError(`import-${error.code}`, false);
    throw error;
  }
}
