import { boundsFromPoints, type Bounds } from "../../../domain/geometry/public";
import type { SelectionPreviewTransform } from "../../../editor/selection/public";
import {
  selectionFrameBoundsPoints,
  transformSelectionPoint,
} from "../../../editor/selection/selection-frame";
import type { PreviewBoundsTransform } from "../../../rendering/scene/types";

/** Adapts the editor's affine preview to conservative scene bounds without reading samples. */
export function selectionPreviewBounds(
  transform: SelectionPreviewTransform,
): PreviewBoundsTransform {
  return (bounds: Bounds, paintPadding = 0): Bounds => {
    const projected = boundsFromPoints(
      selectionFrameBoundsPoints(bounds).map((point) => transformSelectionPoint(point, transform)),
    );
    // Snapshots restore fixed paint widths; the affine projection may shrink their reserve.
    // The shared point projection rounds to thousandths; retain both sides of that boundary.
    const reserve = paintPadding + 0.001;
    return {
      minX: projected.minX - reserve,
      minY: projected.minY - reserve,
      maxX: projected.maxX + reserve,
      maxY: projected.maxY + reserve,
    };
  };
}
