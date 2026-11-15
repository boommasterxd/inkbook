import type { TextElementV2, TextLayoutLineV2, TextLayoutRunV2 } from "../schema/types";
import {
  boundsCorners,
  boundsFromPoints,
  rotatePointsClockwise,
  unionBounds,
  type Bounds,
} from "./primitives";

/** Native glyph ink is baseline-relative; typography alone is not a safe glyph clip. */
export function textRunPaintBounds(
  element: TextElementV2,
  line: TextLayoutLineV2,
  run: TextLayoutRunV2,
): Bounds {
  const x = element.x + line.x + run.x;
  const y = element.y + line.y;
  const lineBounds = {
    minX: x,
    minY: y,
    maxX: x + run.width,
    maxY: y + line.height,
  };
  // Legacy ordinary text may use its layout region for culling, never as an Auto clip.
  const ink = run.inkBounds;
  if (ink === undefined) return lineBounds;
  const baseline = y + line.baseline;
  const bounds = {
    minX: x + ink.minX,
    minY: baseline + ink.minY,
    maxX: x + ink.maxX,
    maxY: baseline + ink.maxY,
  };
  return (run.style?.underline ?? element.style.underline) ||
    (run.style?.strikethrough ?? element.style.strikethrough)
    ? unionBounds(bounds, lineBounds)
    : bounds;
}

/** Math and table layouts already carry their own local paint rectangle. */
export function textLayoutPaintBounds(
  element: TextElementV2,
  layout: Readonly<{ x: number; y: number; width: number; height: number }>,
): Bounds {
  return {
    minX: element.x + layout.x,
    minY: element.y + layout.y,
    maxX: element.x + layout.x + layout.width,
    maxY: element.y + layout.y + layout.height,
  };
}

export function rotatedTextPaintBounds(element: TextElementV2, bounds: Bounds): Bounds {
  if (element.rotation === 0) return bounds;
  return boundsFromPoints(
    rotatePointsClockwise(boundsCorners(bounds), element.pivot, element.rotation),
  );
}
