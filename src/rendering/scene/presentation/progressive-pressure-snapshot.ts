import { sameLocalSelectionShape } from "../../../domain/store/records/prepared-stroke-center-cache";
import { immutableLocalShape } from "../content/stroke-position";
import { ProgressivePreviewPath } from "../content/progressive-preview-path";
import type { PendingPath, PreviewRequest } from "./progressive-preview-request";

/** Retains only canonical pressure work that still represents the requested local shape. */
export function refreshPressureSnapshot(
  pending: PendingPath,
  request: PreviewRequest,
): PendingPath | undefined {
  const element = request.materialize(pending.element.id);
  const reusable =
    pending.element.kind === "stroke" &&
    element?.kind === "stroke" &&
    immutableLocalShape(pending.element) &&
    immutableLocalShape(element) &&
    sameLocalSelectionShape(pending.element, element);
  if (!reusable) pending.path.cancel();
  return element === undefined
    ? undefined
    : {
        element,
        feedback: request.feedback,
        path: reusable ? pending.path : new ProgressivePreviewPath(element),
        version: request.version,
        pressureEnabled: element.kind === "stroke" && element.style.pressureEnabled,
      };
}
