import type { PointV1, StrokeElementV1 } from "../schema/types";
import { canonicalPoint, rotatePointClockwise, roundCanonical } from "./primitives";

/** Samples are shape-space coordinates; the pivot remains in world space. */
export function strokeWorldPoint(stroke: StrokeElementV1, point: PointV1): PointV1 {
  const translated = {
    x: point.x + (stroke.offset?.x ?? 0),
    y: point.y + (stroke.offset?.y ?? 0),
  };
  return stroke.rotation === 0
    ? translated
    : rotatePointClockwise(translated, stroke.pivot, stroke.rotation);
}

/** Geometry for a retained path positioned by an outer SVG translation. */
export function strokeLocalGeometry(stroke: StrokeElementV1): StrokeElementV1 {
  if (stroke.offset === undefined) return stroke;
  const { offset, ...local } = stroke;
  return {
    ...local,
    pivot: canonicalPoint({ x: stroke.pivot.x - offset.x, y: stroke.pivot.y - offset.y }),
  };
}

/** Compare retained shape-space pivots without allocating translated stroke headers. */
export function sameStrokeLocalPivot(a: StrokeElementV1, b: StrokeElementV1): boolean {
  return (
    roundCanonical(a.pivot.x - (a.offset?.x ?? 0)) ===
      roundCanonical(b.pivot.x - (b.offset?.x ?? 0)) &&
    roundCanonical(a.pivot.y - (a.offset?.y ?? 0)) ===
      roundCanonical(b.pivot.y - (b.offset?.y ?? 0))
  );
}

export function translatedStroke(stroke: StrokeElementV1, delta: PointV1): StrokeElementV1 {
  return {
    ...stroke,
    offset: canonicalPoint({
      x: (stroke.offset?.x ?? 0) + delta.x,
      y: (stroke.offset?.y ?? 0) + delta.y,
    }),
    pivot: canonicalPoint({ x: stroke.pivot.x + delta.x, y: stroke.pivot.y + delta.y }),
  };
}
