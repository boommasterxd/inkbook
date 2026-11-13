import type { PointV1 } from "../schema/types";
import { canonicalizeGeometryNumber as number } from "../schema/canonical";
import { textPaddingForWidth } from "./text-padding";
import type { PaintRectangle } from "./rectangle-cutouts";
import { arcTo, lineTo, moveTo } from "./svg-format";

interface Vertex extends PointV1 {
  corners?: number;
}

export interface TextBackgroundBoundary {
  readonly start: PointV1;
  readonly end: PointV1;
  readonly radius?: number;
}

const EPSILON = 1e-9;

/** Scales the visible contour with the field's text and keeps it inside the content inset. */
export function textBackgroundRadius(box: PaintRectangle, fontSize: number): number {
  return Math.min(textPaddingForWidth(fontSize, box.width), Math.floor(box.height * 500) / 1000);
}

/** Callers supply the field radius; the fixed default retains the former geometric primitive. */
export function textBackgroundBoxPath(box: PaintRectangle, radius = 2): string {
  return roundedBackgroundIntersection(box, box, radius);
}

/** Intersect a paint strip with the field contour, retaining exact circular corner arcs. */
export function roundedBackgroundIntersection(
  box: PaintRectangle,
  strip: PaintRectangle,
  requestedRadius = 2,
): string {
  const rectangle = intersection(box, strip);
  if (!rectangle) return "";
  const radius = Math.min(requestedRadius, box.width / 2, box.height / 2);
  const corners = rectangleCorners(rectangle);
  if (corners.every((point) => insideRoundedBox(point, box, radius)))
    return rectangleBackgroundPath(rectangle);
  return boundaryPath(intersectionVertices(box, rectangle, radius), radius);
}

/** Directed segments retain the same rounded contour before adjacent strips are joined. */
export function roundedBackgroundBoundary(
  box: PaintRectangle,
  strip: PaintRectangle,
  requestedRadius = 2,
): readonly TextBackgroundBoundary[] {
  const rectangle = intersection(box, strip);
  if (!rectangle) return [];
  const radius = Math.min(requestedRadius, box.width / 2, box.height / 2);
  const corners = rectangleCorners(rectangle);
  const vertices: Vertex[] = corners.every((point) => insideRoundedBox(point, box, radius))
    ? corners
    : boundaryVertices(intersectionVertices(box, rectangle, radius));
  if (vertices.length < 3) return [];
  return vertices.map((point, index) => {
    const next = vertices[(index + 1) % vertices.length]!;
    return {
      start: { x: number(point.x), y: number(point.y) },
      end: { x: number(next.x), y: number(next.y) },
      ...(((point.corners ?? 0) & (next.corners ?? 0)) !== 0 ? { radius } : {}),
    };
  });
}

function intersectionVertices(
  box: PaintRectangle,
  rectangle: PaintRectangle,
  radius: number,
): Vertex[] {
  const corners = rectangleCorners(rectangle);
  const vertices: Vertex[] = corners.filter((point) => insideRoundedBox(point, box, radius));
  appendStraightEdges(vertices, box, rectangle, radius);
  for (const [index, corner] of rectangleCorners(box).entries()) {
    const sx = index === 0 || index === 3 ? -1 : 1;
    const sy = index < 2 ? -1 : 1;
    if (
      !intersection(rectangle, {
        x: corner.x - (sx > 0 ? radius : 0),
        y: corner.y - (sy > 0 ? radius : 0),
        width: radius,
        height: radius,
      })
    )
      continue;
    appendArc(vertices, rectangle, {
      x: corner.x - sx * radius,
      y: corner.y - sy * radius,
      sx,
      sy,
      radius,
      index,
    });
  }
  return vertices;
}

function rectangleCorners(box: PaintRectangle): PointV1[] {
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ];
}

function insideRoundedBox(point: PointV1, box: PaintRectangle, radius: number): boolean {
  const dx = Math.max(box.x + radius - point.x, 0, point.x - box.x - box.width + radius);
  const dy = Math.max(box.y + radius - point.y, 0, point.y - box.y - box.height + radius);
  return dx * dx + dy * dy <= radius * radius + EPSILON;
}

function intersection(box: PaintRectangle, other: PaintRectangle): PaintRectangle | undefined {
  const x = Math.max(box.x, other.x);
  const y = Math.max(box.y, other.y);
  const width = Math.min(box.x + box.width, other.x + other.width) - x;
  const height = Math.min(box.y + box.height, other.y + other.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

function appendStraightEdges(
  vertices: Vertex[],
  box: PaintRectangle,
  rectangle: PaintRectangle,
  radius: number,
): void {
  const edges = [
    { x: box.x + radius, y: box.y, width: box.width - 2 * radius, height: 0 },
    { x: box.x + radius, y: box.y + box.height, width: box.width - 2 * radius, height: 0 },
    { x: box.x, y: box.y + radius, width: 0, height: box.height - 2 * radius },
    { x: box.x + box.width, y: box.y + radius, width: 0, height: box.height - 2 * radius },
  ];
  for (const edge of edges) {
    const x = Math.max(edge.x, rectangle.x);
    const y = Math.max(edge.y, rectangle.y);
    const right = Math.min(edge.x + edge.width, rectangle.x + rectangle.width);
    const bottom = Math.min(edge.y + edge.height, rectangle.y + rectangle.height);
    if (right >= x && bottom >= y) vertices.push({ x, y }, { x: right, y: bottom });
  }
}

interface Corner extends PointV1 {
  readonly sx: number;
  readonly sy: number;
  readonly radius: number;
  readonly index: number;
}

function appendArc(vertices: Vertex[], rectangle: PaintRectangle, corner: Corner): void {
  const angles = [0, Math.PI / 2];
  for (const x of [rectangle.x, rectangle.x + rectangle.width]) {
    const ratio = (x - corner.x) / (corner.sx * corner.radius);
    if (ratio >= 0 && ratio <= 1) angles.push(Math.acos(ratio));
  }
  for (const y of [rectangle.y, rectangle.y + rectangle.height]) {
    const ratio = (y - corner.y) / (corner.sy * corner.radius);
    if (ratio >= 0 && ratio <= 1) angles.push(Math.asin(ratio));
  }
  const points = angles
    .sort((left, right) => left - right)
    .map((angle) => ({
      x: corner.x + corner.sx * corner.radius * Math.cos(angle),
      y: corner.y + corner.sy * corner.radius * Math.sin(angle),
      corners: 1 << corner.index,
    }))
    .filter(
      (point) =>
        point.x >= rectangle.x - EPSILON &&
        point.x <= rectangle.x + rectangle.width + EPSILON &&
        point.y >= rectangle.y - EPSILON &&
        point.y <= rectangle.y + rectangle.height + EPSILON,
    );
  if (points.length) vertices.push(points[0]!, points[points.length - 1]!);
}

function boundaryPath(vertices: Vertex[], radius: number): string {
  const unique = boundaryVertices(vertices);
  if (unique.length < 3) return "";
  let path = moveTo(unique[0]!);
  for (let index = 1; index <= unique.length; index += 1) {
    const previous = unique[index - 1]!;
    const next = unique[index % unique.length]!;
    path +=
      ((previous.corners ?? 0) & (next.corners ?? 0)) !== 0 ? arcTo(radius, 1, next) : lineTo(next);
  }
  return `${path}Z`;
}

function boundaryVertices(vertices: Vertex[]): Vertex[] {
  const unique: Vertex[] = [];
  for (const vertex of vertices) {
    const previous = unique.find(
      (point) => Math.abs(point.x - vertex.x) < EPSILON && Math.abs(point.y - vertex.y) < EPSILON,
    );
    if (!previous) unique.push(vertex);
    else if (vertex.corners !== undefined)
      previous.corners = (previous.corners ?? 0) | vertex.corners;
  }
  const x = unique.reduce((sum, point) => sum + point.x, 0) / unique.length;
  const y = unique.reduce((sum, point) => sum + point.y, 0) / unique.length;
  unique.sort(
    (left, right) => Math.atan2(left.y - y, left.x - x) - Math.atan2(right.y - y, right.x - x),
  );
  return unique;
}

export function rectangleBackgroundPath(rectangle: PaintRectangle): string {
  const x = number(rectangle.x);
  const y = number(rectangle.y);
  return `M${x} ${y}H${number(x + rectangle.width)}V${number(y + rectangle.height)}H${x}Z`;
}
