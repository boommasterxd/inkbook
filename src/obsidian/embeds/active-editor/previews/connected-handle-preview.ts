import type { InkElementV1 } from "../../../../domain/schema/public";
import { LockedElementMutationError } from "../../../../domain/store/public";
import type {
  ConnectedSelectionPreview,
  SelectionHandlePreview,
} from "../../../../editor/selection/public";
import type { ActiveHandleGesture } from "./handle-preview-commit";

/** Keep fixed connected lines stationary before publishing a root transform. */
export function connectedHandlePreview(
  active: Pick<ActiveHandleGesture, "connectedPreview">,
  preview: SelectionHandlePreview,
  materializeRoot: ((id: string) => InkElementV1 | undefined) | undefined,
): ConnectedSelectionPreview | null {
  try {
    if (preview.transform === null)
      return preview.exactPreviewTruncated
        ? active.connectedPreview.updateTargets(preview.exactElements)
        : { elements: [], selectedPreviewIds: new Set() };
    if (!preview.exactPreviewTruncated)
      return { elements: [], selectedPreviewIds: active.connectedPreview.selectedPreviewIds };
    return active.connectedPreview.update(preview.transform, materializeRoot);
  } catch (error: unknown) {
    if (error instanceof LockedElementMutationError) return null;
    throw error;
  }
}
