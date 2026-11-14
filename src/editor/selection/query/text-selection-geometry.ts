import {
  boundsFromPoints,
  rotatePointClockwise,
  type Bounds,
} from "../../../domain/geometry/public";
import { roundedBackgroundBoundary } from "../../../domain/geometry/rounded-background-path";
import {
  prepareTextPaintGeometrySteps,
  type TextPaintGeometry,
} from "../../../domain/geometry/text-paint-geometry";
import type { TextPaintRegion } from "../../../domain/geometry/text-paint-regions";
import type { PointV1, TextElementV2 } from "../../../domain/schema/public";
import type { VisibleSelectionPrimitive } from "./selection-area-primitives";
import { selectionFrameBoundsPoints } from "../selection-frame";

/** Keep text work cooperative, with the retained local index pruning touched queries. */
export function* textSelectionPrimitiveSteps(
  element: TextElementV2,
  geometry?: TextPaintGeometry,
  bounds?: Bounds,
): Generator<VisibleSelectionPrimitive | undefined> {
  let prepared = geometry;
  if (prepared === undefined) {
    const steps = prepareTextPaintGeometrySteps(element);
    let step = steps.next();
    while (!step.done) {
      yield undefined;
      step = steps.next();
    }
    prepared = step.value;
  }
  for (const region of prepared.querySteps(bounds && localBounds(element, bounds))) {
    if (region === undefined) {
      yield undefined;
      continue;
    }
    const points = regionPoints(region).map((point) =>
      rotatePointClockwise(
        { x: element.x + point.x, y: element.y + point.y },
        element.pivot,
        element.rotation,
      ),
    );
    if (points.length >= 3) yield { kind: "polygon", points };
  }
}

function localBounds(element: TextElementV2, bounds: Bounds): Bounds {
  return boundsFromPoints(
    selectionFrameBoundsPoints(bounds).map((point) => {
      const local = rotatePointClockwise(point, element.pivot, -element.rotation);
      return { x: local.x - element.x, y: local.y - element.y };
    }),
  );
}

function regionPoints(region: TextPaintRegion): readonly PointV1[] {
  if (region.roundedClip === undefined)
    return [
      { x: region.x, y: region.y },
      { x: region.x + region.width, y: region.y },
      { x: region.x + region.width, y: region.y + region.height },
      { x: region.x, y: region.y + region.height },
    ];
  const clip = region.roundedClip;
  const points: PointV1[] = [];
  for (const edge of roundedBackgroundBoundary(
    { x: 0, y: 0, width: clip.width, height: clip.height },
    region,
    clip.radius,
  )) {
    points.push(edge.start);
    if (edge.radius !== undefined) appendArc(points, edge.start, edge.end, edge.radius);
  }
  return points;
}

/** Match the existing 64-segment circular selection contour's bounded approximation. */
function appendArc(points: PointV1[], start: PointV1, end: PointV1, radius: number): void {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const chord = Math.hypot(dx, dy);
  if (chord === 0 || radius <= 0) return;
  const offset = Math.sqrt(Math.max(0, radius * radius - (chord * chord) / 4)) / chord;
  const center = { x: (start.x + end.x) / 2 - dy * offset, y: (start.y + end.y) / 2 + dx * offset };
  const angle = Math.atan2(start.y - center.y, start.x - center.x);
  const sweep =
    (Math.atan2(end.y - center.y, end.x - center.x) - angle + Math.PI * 2) % (Math.PI * 2);
  const segments = Math.ceil(sweep / (Math.PI / 32));
  for (let index = 1; index < segments; index += 1) {
    const next = angle + (sweep * index) / segments;
    points.push({ x: center.x + Math.cos(next) * radius, y: center.y + Math.sin(next) * radius });
  }
}
