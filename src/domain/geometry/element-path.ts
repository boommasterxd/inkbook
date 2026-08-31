import type {
  ArrowNodeV1,
  BoxShapeElementV1,
  CoordinateSystemElementV1,
  InkElementV1,
  LinearElementV1,
  PointV1,
  TableElementV1,
} from "../schema/types";
import { shapeVertices, tableColumnOffsets, tableWidth } from "./creation";
import {
  addPoints,
  normalizedVector,
  rotatePointClockwise,
  rotateVectorClockwise,
  scalePoint,
  subtractPoints,
} from "./primitives";
import { buildStrokePath } from "./stroke-path";
import { arcTo, cubicTo, lineTo, moveTo, quadraticTo } from "./svg-format";

export interface SvgPathPart {
  d: string;
  paint: "fill" | "fill-and-stroke" | "stroke";
}

export type ArrowNodeGeometry =
  | { kind: "none" }
  | { kind: "open"; endpoint: PointV1; tips: readonly [PointV1, PointV1] }
  | { kind: "polygon"; points: readonly PointV1[] }
  | { kind: "circle"; center: PointV1; radius: number };

const ELLIPSE_KAPPA = 0.552_284_749_831;

export function buildElementPathParts(element: InkElementV1): SvgPathPart[] {
  if (element.kind === "stroke") return [buildStrokePath(element)];
  if (element.kind === "coordinate-system")
    return [{ d: buildCoordinateSystemPath(element), paint: "stroke" }];
  if (element.kind === "table") return [{ d: buildTablePath(element), paint: "stroke" }];
  if (
    element.kind === "line" ||
    element.kind === "arrow" ||
    element.kind === "straight-highlighter"
  ) {
    return buildLinearPathParts(element);
  }
  return [{ d: buildClosedShapePath(element), paint: "fill-and-stroke" }];
}

export function buildClosedShapePath(shape: BoxShapeElementV1): string {
  if (shape.kind === "ellipse") return buildEllipsePath(shape);
  const points = shapeVertices(shape).map((point) => rotatedFor(shape, point));
  return closedPolygonPath(points);
}

export function buildTablePath(table: TableElementV1): string {
  const width = tableWidth(table);
  const topLeft = { x: table.x, y: table.y };
  const topRight = { x: table.x + width, y: table.y };
  const bottomRight = { x: table.x + width, y: table.y + table.height };
  const bottomLeft = { x: table.x, y: table.y + table.height };
  const commands = [
    closedPolygonPath(
      [topLeft, topRight, bottomRight, bottomLeft].map((point) => rotatedFor(table, point)),
    ),
  ];
  for (const offset of tableColumnOffsets(table)) {
    commands.push(
      lineSubpath(
        rotatedFor(table, { x: table.x + offset, y: table.y }),
        rotatedFor(table, { x: table.x + offset, y: table.y + table.height }),
      ),
    );
  }
  commands.push(
    lineSubpath(
      rotatedFor(table, { x: table.x, y: table.y + table.headerHeight }),
      rotatedFor(table, { x: table.x + width, y: table.y + table.headerHeight }),
    ),
  );
  return commands.join("");
}

export function buildCoordinateSystemPath(system: CoordinateSystemElementV1): string {
  const origin = rotatedFor(system, system.origin);
  const commands: string[] = [];
  for (const endpointValue of system.axes) {
    const endpoint = rotatedFor(system, endpointValue);
    commands.push(lineSubpath(origin, endpoint));
    const direction = normalizedVector(subtractPoints(endpoint, origin));
    if (direction === null) continue;
    const node = arrowNodeGeometry(
      endpoint,
      direction,
      "arrow",
      nodeSize(system.style.outlineWidth),
    );
    if (node.kind === "open") commands.push(openNodePath(node));
  }
  return commands.join("");
}

export function buildLinearPathParts(linear: LinearElementV1): SvgPathPart[] {
  const start = rotatedFor(linear, linear.start);
  const end = rotatedFor(linear, linear.end);
  const bend = linear.bend === null ? null : rotatedFor(linear, linear.bend);
  const body =
    bend === null ? lineSubpath(start, end) : `${moveTo(start)}${quadraticTo(bend, end)}`;
  if (linear.kind !== "arrow") return [{ d: body, paint: "stroke" }];

  const directions = linearEndpointDirections(start, end, bend);
  const size = nodeSize(linear.style.outlineWidth);
  const nodes = [
    arrowNodeGeometry(start, directions.start, linear.startNode, size),
    arrowNodeGeometry(end, directions.end, linear.endNode, size),
  ];
  const openPaths = nodes.filter((node) => node.kind === "open").map(openNodePath);
  const filledPaths = nodes
    .filter((node) => node.kind === "polygon" || node.kind === "circle")
    .map(filledNodePath);
  const parts: SvgPathPart[] = [{ d: [body, ...openPaths].join(""), paint: "stroke" }];
  if (filledPaths.length > 0) parts.push({ d: filledPaths.join(""), paint: "fill" });
  return parts;
}

export function arrowNodeGeometry(
  endpoint: PointV1,
  outwardDirection: PointV1,
  node: ArrowNodeV1,
  size: number,
): ArrowNodeGeometry {
  if (node === "none") return { kind: "none" };
  const normalized = normalizedVector(outwardDirection);
  if (normalized === null) throw new RangeError("Arrow node direction must be non-zero.");
  const direction = { x: normalized.x, y: normalized.y };
  const perpendicular = { x: -direction.y, y: direction.x };
  if (node === "arrow") {
    const positive = rotateVectorClockwise(direction, 30);
    const negative = rotateVectorClockwise(direction, -30);
    return {
      kind: "open",
      endpoint,
      tips: [
        subtractPoints(endpoint, scalePoint(positive, size)),
        subtractPoints(endpoint, scalePoint(negative, size)),
      ],
    };
  }
  if (node === "circle") {
    return {
      kind: "circle",
      center: subtractPoints(endpoint, scalePoint(direction, size / 2)),
      radius: size / 2,
    };
  }

  const back = subtractPoints(endpoint, scalePoint(direction, size));
  if (node === "triangle") {
    return {
      kind: "polygon",
      points: [
        endpoint,
        addPoints(back, scalePoint(perpendicular, size / 2)),
        subtractPoints(back, scalePoint(perpendicular, size / 2)),
      ],
    };
  }
  return {
    kind: "polygon",
    points: [
      endpoint,
      addPoints(
        subtractPoints(endpoint, scalePoint(direction, size / 2)),
        scalePoint(perpendicular, size / 2),
      ),
      back,
      subtractPoints(
        subtractPoints(endpoint, scalePoint(direction, size / 2)),
        scalePoint(perpendicular, size / 2),
      ),
    ],
  };
}

export function nodeSize(outlineWidth: number): number {
  return Math.max(12, outlineWidth * 4);
}

function buildEllipsePath(ellipse: BoxShapeElementV1): string {
  const center = { x: ellipse.x + ellipse.width / 2, y: ellipse.y + ellipse.height / 2 };
  const radiusX = ellipse.width / 2;
  const radiusY = ellipse.height / 2;
  const horizontalControl = radiusX * ELLIPSE_KAPPA;
  const verticalControl = radiusY * ELLIPSE_KAPPA;
  const point = (x: number, y: number): PointV1 => rotatedFor(ellipse, { x, y });
  const right = point(center.x + radiusX, center.y);
  return [
    moveTo(right),
    cubicTo(
      point(center.x + radiusX, center.y + verticalControl),
      point(center.x + horizontalControl, center.y + radiusY),
      point(center.x, center.y + radiusY),
    ),
    cubicTo(
      point(center.x - horizontalControl, center.y + radiusY),
      point(center.x - radiusX, center.y + verticalControl),
      point(center.x - radiusX, center.y),
    ),
    cubicTo(
      point(center.x - radiusX, center.y - verticalControl),
      point(center.x - horizontalControl, center.y - radiusY),
      point(center.x, center.y - radiusY),
    ),
    cubicTo(
      point(center.x + horizontalControl, center.y - radiusY),
      point(center.x + radiusX, center.y - verticalControl),
      right,
    ),
    "Z",
  ].join("");
}

export function linearEndpointDirections(
  start: PointV1,
  end: PointV1,
  bend: PointV1 | null,
): { start: PointV1; end: PointV1 } {
  const full = normalizedVector(subtractPoints(end, start));
  if (full === null) throw new RangeError("Linear geometry must be non-degenerate.");
  const startTangent = normalizedVector(subtractPoints(bend ?? end, start)) ?? full;
  const endTangent = normalizedVector(subtractPoints(end, bend ?? start)) ?? full;
  return {
    start: { x: -startTangent.x, y: startTangent.y === 0 ? 0 : -startTangent.y },
    end: { x: endTangent.x, y: endTangent.y },
  };
}

export function outlineDashPattern(
  style: "solid" | "dashed" | "dotted",
  outlineWidth: number,
): readonly number[] | null {
  if (style === "solid") return null;
  if (style === "dashed") return [4 * outlineWidth, 3 * outlineWidth];
  return [0, 2.5 * outlineWidth];
}

function rotatedFor(element: Pick<InkElementV1, "pivot" | "rotation">, point: PointV1): PointV1 {
  return rotatePointClockwise(point, element.pivot, element.rotation);
}

function lineSubpath(start: PointV1, end: PointV1): string {
  return `${moveTo(start)}${lineTo(end)}`;
}

function closedPolygonPath(points: readonly PointV1[]): string {
  return [moveTo(points[0]!), ...points.slice(1).map(lineTo), "Z"].join("");
}

function openNodePath(node: Extract<ArrowNodeGeometry, { kind: "open" }>): string {
  return `${moveTo(node.tips[0])}${lineTo(node.endpoint)}${lineTo(node.tips[1])}`;
}

function filledNodePath(node: Extract<ArrowNodeGeometry, { kind: "polygon" | "circle" }>): string {
  if (node.kind === "polygon") return closedPolygonPath(node.points);
  const left = addPoints(node.center, { x: -node.radius, y: 0 });
  const right = addPoints(node.center, { x: node.radius, y: 0 });
  return `${moveTo(left)} ${arcTo(node.radius, 1, right)} ${arcTo(node.radius, 1, left)} Z`;
}
