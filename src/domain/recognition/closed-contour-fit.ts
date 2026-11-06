import { shapeVertices } from "../geometry/creation";
import type { Bounds } from "../geometry/primitives";
import type { PointV1 } from "../schema/types";
import type { RecognizedClosedShape } from "./recognition-types";

interface AxisMoments {
  source: number;
  template: number;
  square: number;
  cross: number;
}

/** Bounded projection steps fit the native contour without changing its vertex contract. */
export function* refinePolygonBoundsSteps(
  points: readonly PointV1[],
  original: Bounds,
  kind: RecognizedClosedShape["kind"],
): Generator<void, Bounds> {
  let bounds = original;
  for (let iteration = 0; iteration < 2; iteration++) {
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    const vertices = shapeVertices({ kind, x: bounds.minX, y: bounds.minY, width, height });
    const horizontal: AxisMoments = { source: 0, template: 0, square: 0, cross: 0 };
    const vertical: AxisMoments = { ...horizontal };
    for (const point of points) {
      const x = point.x;
      const y = point.y;
      const projected = nearestBoundaryPoint(x, y, vertices);
      recordMoment(horizontal, x, (projected.x - bounds.minX) / width);
      recordMoment(vertical, y, (projected.y - bounds.minY) / height);
    }
    const x = fitAxis(horizontal, points.length);
    const y = fitAxis(vertical, points.length);
    const next = {
      minX: x.offset,
      maxX: x.offset + x.size,
      minY: y.offset,
      maxY: y.offset + y.size,
    };
    if (!boundedFit(next, original)) break;
    bounds = next;
    yield;
  }
  return bounds;
}

function recordMoment(moment: AxisMoments, source: number, template: number): void {
  moment.source += source;
  moment.template += template;
  moment.square += template * template;
  moment.cross += source * template;
}

function fitAxis(moment: AxisMoments, count: number) {
  const size =
    (moment.cross - (moment.source * moment.template) / count) /
    (moment.square - moment.template ** 2 / count);
  return { size, offset: (moment.source - size * moment.template) / count };
}

function nearestBoundaryPoint(x: number, y: number, vertices: readonly PointV1[]): PointV1 {
  let nearestX = vertices[0]!.x;
  let nearestY = vertices[0]!.y;
  let squared = Infinity;
  for (let index = 0; index < vertices.length; index++) {
    const start = vertices[index]!;
    const end = vertices[(index + 1) % vertices.length]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const t = Math.max(
      0,
      Math.min(1, ((x - start.x) * dx + (y - start.y) * dy) / (dx * dx + dy * dy)),
    );
    const projectedX = start.x + t * dx;
    const projectedY = start.y + t * dy;
    const distance = (x - projectedX) ** 2 + (y - projectedY) ** 2;
    if (distance < squared) {
      squared = distance;
      nearestX = projectedX;
      nearestY = projectedY;
    }
  }
  return { x: nearestX, y: nearestY };
}

function boundedFit(next: Bounds, original: Bounds): boolean {
  const width = original.maxX - original.minX;
  const height = original.maxY - original.minY;
  const fittedWidth = next.maxX - next.minX;
  const fittedHeight = next.maxY - next.minY;
  return (
    Number.isFinite(fittedWidth) &&
    Number.isFinite(fittedHeight) &&
    fittedWidth >= width * 0.8 &&
    fittedWidth <= width * 1.2 &&
    fittedHeight >= height * 0.8 &&
    fittedHeight <= height * 1.2 &&
    Math.abs(next.minX - original.minX) <= width * 0.1 &&
    Math.abs(next.minY - original.minY) <= height * 0.1
  );
}
