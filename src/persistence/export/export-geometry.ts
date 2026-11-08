import {
  prepareExportCutsSteps,
  type PreparedExportCuts,
} from "../../domain/export/export-pagination";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import type { SafeStaticProof } from "../serialization/input/safe-static-proof";
import { consumeSerializationSteps } from "../serialization/output/serialization-model-preparation";
import type { DocumentRuntimePort } from "../worker/runtime/types";
import type { PurposeOperationIdentity } from "../worker/protocol";
import { assertResultMatchesRequest } from "../worker/runtime/bridge/request-result-validation";

interface ExportGeometryOptions {
  readonly runtime: DocumentRuntimePort;
  readonly identity: PurposeOperationIdentity;
  readonly workScheduler: WorkScheduler;
  readonly signal?: AbortSignal;
  readonly safeStaticProof?: SafeStaticProof;
}

/** Invalid editable metadata leaves a separately validated static graphic available to the caller. */
export async function prepareExportGeometry(
  safeSvg: string,
  options: ExportGeometryOptions,
): Promise<PreparedExportCuts | undefined> {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const context = {
    signal,
    checkpoint: () => options.workScheduler.checkpoint(signal),
  };
  const pending = context.checkpoint();
  if (pending !== undefined) await pending;
  signal.throwIfAborted();
  const request = {
    identity: options.identity,
    input: safeSvg,
    ...(options.safeStaticProof === undefined ? {} : { safeStaticProof: options.safeStaticProof }),
    type: "prepare-export-geometry" as const,
  };
  const result = await options.runtime.execute(request);
  signal.throwIfAborted();
  await assertResultMatchesRequest(request, result, context);
  if (result.type !== "prepare-export-geometry-success") {
    throw new Error("Export geometry execution failed.");
  }
  if (result.intervals === undefined) return undefined;
  return consumeSerializationSteps(prepareExportCutsSteps(result.intervals), context);
}
