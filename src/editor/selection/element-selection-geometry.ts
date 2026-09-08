import { effectiveStrokeWidth } from "../../domain/geometry/bounds";
import { shapeVertices, tableLineSegments } from "../../domain/geometry/creation";
import {
  arrowNodeGeometry,
  linearEndpointDirections,
  nodeSize,
  type ArrowNodeGeometry,
} from "../../domain/geometry/element-path";
import { quadraticPoint, rotatePointClockwise } from "../../domain/geometry/public";
import { visitPressureOutline } from "../../domain/geometry/pressure-outline";
import { visitPressureSelectionPrimitives } from "./pressure-selection-primitives";
import { smoothStrokeCenters } from "../../domain/geometry/stroke-path";
import type {
  BoxShapeElementV1,
  InkElementV1,
  LinearElementV1,
  PointV1,
  StrokeElementV1,
} from "../../domain/schema/public";

import type { VisibleSelectionPrimitive } from "./selection-area-primitives";

export type SelectionPrimitiveVisitor = (primitive: VisibleSelectionPrimitive) => boolean;

const CURVE_SEGMENTS = 24;
const ELLIPSE_SEGMENTS = 64;

export function visitVisibleElementPrimitives(
  element: InkElementV1,
  visitor: SelectionPrimitiveVisitor,
): boolean {
  if (element.kind === "stroke") return visitStroke(element, visitor);
  if (element.kind === "coordinate-system") return visitCoordinateSystem(element, visitor);
  if (element.kind === "table") return visitTable(element, visitor);
  if (
    element.kind === "line" ||
    element.kind === "arrow" ||
    element.kind === "straight-highlighter"
  ) {
    return visitLinear(element, visitor);
  }
  return visitClosedShape(element, visitor);
}

function visitStroke(
  stroke: Extract<InkElementV1, { kind: "stroke" }>,
  visitor: SelectionPrimitiveVisitor,
): boolean {
  if (stroke.style.opacity <= 0) return true;
  const smoothed = smoothStrokeCenters(stroke.points);
  const centers =
    stroke.rotation === 0
      ? smoothed
      : smoothed.map((center) => ({
          ...rotatedFor(stroke, center),
          pressure: center.pressure,
        }));
  if (!stroke.style.pressureEnabled) {
    return visitPolyline(centers, effectiveStrokeWidth(stroke) / 2, false, visitor);
  }
  return visitPressureStroke(stroke, centers, visitor);
}

function visitPressureStroke(
  stroke: StrokeElementV1,
  centers: readonly (PointV1 & { readonly pressure: number })[],
  visitor: SelectionPrimitiveVisitor,
): boolean {
  return !visitPressureOutline(
    centers,
    stroke.style.width,
    (piece) => !visitPressureSelectionPrimitives(piece, visitor),
  );
}

function visitLinear(linear: LinearElementV1, visitor: SelectionPrimitiveVisitor): boolean {
  const opacity =
    linear.kind === "straight-highlighter" ? linear.style.opacity : linear.style.outlineOpacity;
  if (opacity <= 0) return true;
  const start = rotatedFor(linear, linear.start);
  const end = rotatedFor(linear, linear.end);
  const bend = linear.bend === null ? null : rotatedFor(linear, linear.bend);
  const radius =
    (linear.kind === "straight-highlighter"
      ? effectiveStrokeWidth(linear)
      : linear.style.outlineWidth) / 2;
  if (!visitLinearBody(start, end, bend, radius, visitor)) return false;
  if (linear.kind !== "arrow") return true;
  const directions = linearEndpointDirections(start, end, bend);
  const size = nodeSize(linear.style.outlineWidth);
  return (
    visitArrowNode(
      arrowNodeGeometry(start, directions.start, linear.startNode, size),
      radius,
      visitor,
    ) &&
    visitArrowNode(arrowNodeGeometry(end, directions.end, linear.endNode, size), radius, visitor)
  );
}

function visitLinearBody(
  start: PointV1,
  end: PointV1,
  bend: PointV1 | null,
  radius: number,
  visitor: SelectionPrimitiveVisitor,
): boolean {
  if (bend === null) return visitor(capsule(start, end, radius));
  let previous = start;
  for (let step = 1; step <= CURVE_SEGMENTS; step += 1) {
    const current = quadraticPoint(start, bend, end, step / CURVE_SEGMENTS);
    if (!visitor(capsule(previous, current, radius))) return false;
    previous = current;
  }
  return true;
}

function visitArrowNode(
  node: ArrowNodeGeometry,
  radius: number,
  visitor: SelectionPrimitiveVisitor,
): boolean {
  if (node.kind === "none") return true;
  if (node.kind === "open") {
    return (
      visitor(capsule(node.tips[0], node.endpoint, radius)) &&
      visitor(capsule(node.endpoint, node.tips[1], radius))
    );
  }
  if (node.kind === "circle") return visitor(disk(node.center, node.radius + radius));
  return (
    visitor({ kind: "polygon", points: node.points }) &&
    visitPolyline(node.points, radius, true, visitor)
  );
}

function visitCoordinateSystem(
  system: Extract<InkElementV1, { kind: "coordinate-system" }>,
  visitor: SelectionPrimitiveVisitor,
): boolean {
  if (system.style.outlineOpacity <= 0) return true;
  const origin = rotatedFor(system, system.origin);
  const radius = system.style.outlineWidth / 2;
  const size = nodeSize(system.style.outlineWidth);
  for (const axis of system.axes) {
    const endpoint = rotatedFor(system, axis);
    if (!visitor(capsule(origin, endpoint, radius))) return false;
    const direction = { x: endpoint.x - origin.x, y: endpoint.y - origin.y };
    if (!visitArrowNode(arrowNodeGeometry(endpoint, direction, "arrow", size), radius, visitor)) {
      return false;
    }
  }
  return true;
}

function visitTable(
  table: Extract<InkElementV1, { kind: "table" }>,
  visitor: SelectionPrimitiveVisitor,
): boolean {
  if (table.style.outlineOpacity <= 0) return true;
  for (const [start, end] of tableLineSegments(table)) {
    if (
      !visitor(
        capsule(rotatedFor(table, start), rotatedFor(table, end), table.style.outlineWidth / 2),
      )
    ) {
      return false;
    }
  }
  return true;
}

function visitClosedShape(shape: BoxShapeElementV1, visitor: SelectionPrimitiveVisitor): boolean {
  const points =
    shape.kind === "ellipse"
      ? ellipsePoints(shape)
      : shapeVertices(shape).map((point) => rotatedFor(shape, point));
  if (shape.style.outlineOpacity > 0) {
    if (!visitPolyline(points, shape.style.outlineWidth / 2, true, visitor)) return false;
  }
  if (shape.style.fillColor !== null && shape.style.fillOpacity > 0) {
    return visitor({ kind: "polygon", points });
  }
  return true;
}

function ellipsePoints(ellipse: BoxShapeElementV1): readonly PointV1[] {
  const center = { x: ellipse.x + ellipse.width / 2, y: ellipse.y + ellipse.height / 2 };
  const radiusX = ellipse.width / 2;
  const radiusY = ellipse.height / 2;
  const points: PointV1[] = [];
  for (let step = 0; step < ELLIPSE_SEGMENTS; step += 1) {
    const angle = (step / ELLIPSE_SEGMENTS) * Math.PI * 2;
    points.push(
      rotatedFor(ellipse, {
        x: center.x + Math.cos(angle) * radiusX,
        y: center.y + Math.sin(angle) * radiusY,
      }),
    );
  }
  return points;
}

function visitPolyline(
  points: readonly PointV1[],
  radius: number,
  closed: boolean,
  visitor: SelectionPrimitiveVisitor,
): boolean {
  if (points.length === 1) return visitor(disk(points[0]!, radius));
  const segmentCount = closed ? points.length : points.length - 1;
  for (let index = 0; index < segmentCount; index += 1) {
    if (!visitor(capsule(points[index]!, points[(index + 1) % points.length]!, radius))) {
      return false;
    }
  }
  return true;
}

function rotatedFor(element: Pick<InkElementV1, "pivot" | "rotation">, point: PointV1): PointV1 {
  return element.rotation === 0
    ? { x: point.x, y: point.y }
    : rotatePointClockwise(point, element.pivot, element.rotation);
}

function capsule(start: PointV1, end: PointV1, radius: number): VisibleSelectionPrimitive {
  return { kind: "capsule", start, end, radius };
}

function disk(center: PointV1, radius: number): VisibleSelectionPrimitive {
  return capsule(center, center, radius);
}
