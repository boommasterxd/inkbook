import { validatePathDataSteps } from "../../documents/path-data-validator";
import {
  MAX_PREPARED_PRESSURE_HINT_BYTES,
  MAX_PREPARED_PRESSURE_HINTS,
  preparedPressureHintBytes,
  type PreparedPressurePathHint,
} from "../../serialization/prepared-pressure-hints";
import type { IncrementalDocumentSerializer } from "../../serialization/incremental-document-serializer";
import type { DocumentExportRequest, RuntimeSliceContext } from "./types";

/** Defers only changed fragments whose optional paths may replace a contour build. */
export function preparedPressurePathIds(request: DocumentExportRequest): ReadonlySet<string> {
  const candidates: unknown = request.preparedPressurePaths;
  const ids = new Set<string>();
  if (!Array.isArray(candidates)) return ids;
  for (let index = 0; index < Math.min(candidates.length, MAX_PREPARED_PRESSURE_HINTS); index++) {
    const candidate: unknown = candidates[index];
    if (isPreparedPressurePathHint(candidate) && candidate.modelRevision === request.modelRevision)
      ids.add(candidate.id);
  }
  return ids;
}

/** Accepts only bounded, revision-bound paths from the active Store's scene cache. */
export async function acceptPreparedPressurePaths(
  request: DocumentExportRequest,
  serializer: IncrementalDocumentSerializer,
  context?: RuntimeSliceContext,
): Promise<void> {
  const candidates: unknown = request.preparedPressurePaths;
  if (!Array.isArray(candidates)) return;
  const changed =
    request.type === "export-full" || request.includeBaselinePreparedPressurePaths === true
      ? null
      : new Set((request.changedElements ?? []).map(({ id }) => id));
  const accepted = new Set<string>();
  let bytes = 0;
  for (let index = 0; index < Math.min(candidates.length, MAX_PREPARED_PRESSURE_HINTS); index++) {
    context?.signal.throwIfAborted();
    const candidate: unknown = candidates[index];
    if (
      !isPreparedPressurePathHint(candidate) ||
      candidate.modelRevision !== request.modelRevision ||
      (changed !== null && !changed.has(candidate.id)) ||
      accepted.has(candidate.id)
    )
      continue;
    const size = preparedPressureHintBytes(candidate);
    if (size > MAX_PREPARED_PRESSURE_HINT_BYTES - bytes) continue;
    bytes += size;
    const validation = validatePathDataSteps(candidate.d);
    let step = validation.next();
    while (!step.done) {
      const pending = context?.checkpoint();
      if (pending !== undefined) await pending;
      context?.signal.throwIfAborted();
      step = validation.next();
    }
    if (step.value === null) continue;
    if (serializer.seedPreparedPressurePath(candidate.id, candidate.d, candidate.shapeKey))
      accepted.add(candidate.id);
  }
}

function isPreparedPressurePathHint(value: unknown): value is PreparedPressurePathHint {
  if (value === null || typeof value !== "object") return false;
  const hint = value as Partial<PreparedPressurePathHint>;
  return (
    typeof hint.id === "string" &&
    hint.id.length > 0 &&
    typeof hint.d === "string" &&
    typeof hint.shapeKey === "string" &&
    hint.shapeKey.length <= 256 &&
    Number.isSafeInteger(hint.modelRevision) &&
    hint.modelRevision! >= 0 &&
    Number.isSafeInteger(hint.geometryVersion) &&
    hint.geometryVersion! >= 0
  );
}
