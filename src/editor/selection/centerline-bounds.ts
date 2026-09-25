import {
  calculateElementBounds,
  effectiveStrokeWidth,
  type Bounds,
} from "../../domain/geometry/public";
import type { InkElementV1 } from "../../domain/schema/public";

/** Removes only the paint margin; endpoint decorations remain geometric content. */
export function selectionCenterlineBounds(
  element: InkElementV1,
  painted: Bounds = calculateElementBounds(element),
): Bounds {
  const radius =
    (element.kind === "stroke" || element.kind === "straight-highlighter"
      ? effectiveStrokeWidth(element)
      : element.style.outlineWidth) / 2;
  const centerX = (painted.minX + painted.maxX) / 2;
  const centerY = (painted.minY + painted.maxY) / 2;
  return {
    minX: Math.min(centerX, painted.minX + radius),
    minY: Math.min(centerY, painted.minY + radius),
    maxX: Math.max(centerX, painted.maxX - radius),
    maxY: Math.max(centerY, painted.maxY - radius),
  };
}
