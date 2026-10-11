import { strokeLocalGeometry, strokeWorldPoint } from "./stroke-position";
import type {
  BoxShapeElementV1,
  CoordinateSystemElementV1,
  InkElementV1,
  LinearElementV1,
  PointV1,
  StraightHighlighterElementV1,
  StrokeElementV1,
  TableElementV1,
} from "../schema/types";
import { shapeVertices, tableWidth } from "./creation";
import {
  arrowNodeGeometry,
  linearEndpointDirections,
  nodeSize,
  type ArrowNodeGeometry,
} from "./element-path";
import {
  boundsFromPoints,
  expandBounds,
  quadraticBounds,
  rotatePointClockwise,
  unionBounds,
  type Bounds,
} from "./primitives";

export function calculateElementBounds(element: InkElementV1): Bounds {
  const steps = calculateElementBoundsSteps(element, Number.POSITIVE_INFINITY);
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
}

/** Sample batches bound indivisible work; callers decide when their scheduler must yield. */
export function* calculateElementBoundsSteps(
  element: InkElementV1,
  pointsPerStep = 256,
): Generator<void, Bounds> {
  if (pointsPerStep <= 0 || (!Number.isInteger(pointsPerStep) && pointsPerStep !== Infinity)) {
    throw new RangeError("Bounds sample batches must be positive integers or Infinity.");
  }
  if (element.kind === "stroke") return yield* strokeBoundsSteps(element, pointsPerStep);
  if (element.kind === "coordinate-system") return coordinateSystemBounds(element);
  if (element.kind === "table") return rotatedBoxBounds(element);
  if (
    element.kind === "line" ||
    element.kind === "arrow" ||
    element.kind === "straight-highlighter"
  ) {
    return linearBounds(element);
  }
  return closedShapeBounds(element);
}

export function boundsIntersect(left: Bounds, right: Bounds): boolean {
  return !(
    left.maxX < right.minX ||
    left.minX > right.maxX ||
    left.maxY < right.minY ||
    left.minY > right.maxY
  );
}

export function effectiveStrokeWidth(
  stroke:
    | Pick<StrokeElementV1, "kind" | "tool" | "style">
    | Pick<StraightHighlighterElementV1, "kind" | "style">,
): number {
  const isHighlighter = stroke.kind === "straight-highlighter" || stroke.tool === "highlighter";
  return isHighlighter ? stroke.style.width * 2.5 : stroke.style.width;
}

function* strokeBoundsSteps(
  stroke: StrokeElementV1,
  pointsPerStep: number,
): Generator<void, Bounds> {
  const local = strokeLocalGeometry(stroke);
  const bounds = yield* localStrokeBoundsSteps(local, pointsPerStep);
  const x = stroke.offset?.x ?? 0;
  const y = stroke.offset?.y ?? 0;
  return {
    minX: bounds.minX + x,
    minY: bounds.minY + y,
    maxX: bounds.maxX + x,
    maxY: bounds.maxY + y,
  };
}

function* localStrokeBoundsSteps(
  stroke: StrokeElementV1,
  pointsPerStep: number,
): Generator<void, Bounds> {
  const samples = stroke.points;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let index = 0; index < samples.length; index += 3) {
    const previous = index === 0 ? index : index - 3;
    const next = index === samples.length - 3 ? index : index + 3;
    const x =
      index === 0 || index === samples.length - 3
        ? (samples[index] as number)
        : 0.25 * (samples[previous] as number) +
          0.5 * (samples[index] as number) +
          0.25 * (samples[next] as number);
    const y =
      index === 0 || index === samples.length - 3
        ? (samples[index + 1] as number)
        : 0.25 * (samples[previous + 1] as number) +
          0.5 * (samples[index + 1] as number) +
          0.25 * (samples[next + 1] as number);
    const { x: rotatedX, y: rotatedY } = strokeWorldPoint(stroke, { x, y });
    minX = Math.min(minX, rotatedX);
    minY = Math.min(minY, rotatedY);
    maxX = Math.max(maxX, rotatedX);
    maxY = Math.max(maxY, rotatedY);
    if ((index / 3 + 1) % pointsPerStep === 0 && index + 3 < samples.length) yield;
  }
  return expandBounds({ maxX, maxY, minX, minY }, effectiveStrokeWidth(stroke) / 2);
}

function linearBounds(linear: LinearElementV1): Bounds {
  const start = rotatedFor(linear, linear.start);
  const end = rotatedFor(linear, linear.end);
  const bend = linear.bend === null ? null : rotatedFor(linear, linear.bend);
  let bounds = bend === null ? boundsFromPoints([start, end]) : quadraticBounds(start, bend, end);
  const width =
    linear.kind === "straight-highlighter" ? linear.style.width * 2.5 : linear.style.outlineWidth;
  bounds = expandBounds(bounds, width / 2);
  if (linear.kind !== "arrow") return bounds;

  const directions = linearEndpointDirections(start, end, bend);
  const size = nodeSize(linear.style.outlineWidth, start, end);
  return unionBounds(
    bounds,
    expandBounds(
      unionBounds(
        nodeBounds(arrowNodeGeometry(start, directions.start, linear.startNode, size), start),
        nodeBounds(arrowNodeGeometry(end, directions.end, linear.endNode, size), end),
      ),
      linear.style.outlineWidth / 2,
    ),
  );
}

function closedShapeBounds(shape: BoxShapeElementV1): Bounds {
  if (shape.kind === "ellipse" || shape.kind === "rectangle") return rotatedBoxBounds(shape);
  const rotated = shapeVertices(shape).map((point) => rotatedFor(shape, point));
  return expandBounds(boundsFromPoints(rotated), shape.style.outlineWidth / 2);
}

/** Preserves conservative corner bounds without allocating per-corner points and arrays. */
function rotatedBoxBounds(box: BoxShapeElementV1 | TableElementV1): Bounds {
  const width = box.kind === "table" ? tableWidth(box) : box.width;
  const radians = (box.rotation * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const left = box.x - box.pivot.x;
  const right = box.x + width - box.pivot.x;
  const top = box.y - box.pivot.y;
  const bottom = box.y + box.height - box.pivot.y;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let corner = 0; corner < 4; corner += 1) {
    const x = corner === 0 || corner === 3 ? left : right;
    const y = corner < 2 ? top : bottom;
    const rotatedX = box.pivot.x + (x * cosine - y * sine);
    const rotatedY = box.pivot.y + (x * sine + y * cosine);
    minX = Math.min(minX, rotatedX);
    maxX = Math.max(maxX, rotatedX);
    minY = Math.min(minY, rotatedY);
    maxY = Math.max(maxY, rotatedY);
  }
  const radius = box.style.outlineWidth / 2;
  return { minX: minX - radius, minY: minY - radius, maxX: maxX + radius, maxY: maxY + radius };
}

function coordinateSystemBounds(system: CoordinateSystemElementV1): Bounds {
  const origin = rotatedFor(system, system.origin);
  let bounds = boundsFromPoints([origin]);
  for (const axisValue of system.axes) {
    const endpoint = rotatedFor(system, axisValue);
    const size = nodeSize(system.style.outlineWidth, origin, endpoint);
    const axisBounds = expandBounds(
      boundsFromPoints([origin, endpoint]),
      system.style.outlineWidth / 2,
    );
    bounds = unionBounds(bounds, axisBounds);
    const delta = { x: endpoint.x - origin.x, y: endpoint.y - origin.y };
    bounds = unionBounds(
      bounds,
      expandBounds(
        nodeBounds(arrowNodeGeometry(endpoint, delta, "arrow", size), endpoint),
        system.style.outlineWidth / 2,
      ),
    );
  }
  return bounds;
}

function nodeBounds(node: ArrowNodeGeometry, fallback: PointV1): Bounds {
  if (node.kind === "none") return boundsFromPoints([fallback]);
  if (node.kind === "open") return boundsFromPoints([node.endpoint, ...node.tips]);
  if (node.kind === "polygon") return boundsFromPoints(node.points);
  return {
    minX: node.center.x - node.radius,
    minY: node.center.y - node.radius,
    maxX: node.center.x + node.radius,
    maxY: node.center.y + node.radius,
  };
}

function rotatedFor(element: Pick<InkElementV1, "pivot" | "rotation">, point: PointV1): PointV1 {
  return rotatePointClockwise(point, element.pivot, element.rotation);
}
