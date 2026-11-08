import { consumeSerializationSteps } from "../../../serialization/output/serialization-model-preparation";
import { assertExportGeometryRequest } from "../wire/export-geometry-wire";
import type {
  PrepareExportGeometryRequest,
  PrepareExportGeometrySuccess,
  RuntimeSliceContext,
} from "../types";
import { parseExportGeometryInput } from "./runtime-export-input";
import type { SnapshotValidationDerivations } from "../../../../domain/schema/public";
import type { ExportInterval } from "../../../../domain/export/export-pagination";

/** Parses a temporary document without publishing a model, sample buffers, contours or history. */
export async function runPrepareExportGeometry(
  request: PrepareExportGeometryRequest,
  context?: RuntimeSliceContext,
): Promise<PrepareExportGeometrySuccess> {
  assertExportGeometryRequest(request);
  const parsed = await parseExportGeometryInput(request, context);
  context?.signal.throwIfAborted();
  const intervals = parsed.ok
    ? await consumeSerializationSteps(intervalSteps(parsed.value.derivations), context ?? {})
    : undefined;
  return { identity: request.identity, intervals, type: "prepare-export-geometry-success" };
}

function* intervalSteps(
  derivations: SnapshotValidationDerivations,
): Generator<void, readonly ExportInterval[]> {
  const intervals: ExportInterval[] = [];
  for (const { bounds } of derivations.elements) {
    intervals.push({ minY: bounds.minY, maxY: bounds.maxY });
    yield;
  }
  return intervals;
}
