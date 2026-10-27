import type {
  BoxAnchorV1,
  BoxShapeElementV1,
  CoordinateSystemElementV1,
  PointV1,
  ShapeAnchorV1,
  TableElementV1,
  InkElementV1,
  LinearElementV1,
} from "../schema/types";
import { shapeVertices, tableWidth } from "./creation";
import { canonicalPoint, midpoint, rotatePointClockwise } from "./primitives";

type AnchorTransform = Pick<BoxShapeElementV1, "pivot" | "rotation">;

type BoxAnchorTarget = AnchorTransform &
  Pick<BoxShapeElementV1, "height" | "kind" | "width" | "x" | "y">;

type CoordinateAnchorTarget = AnchorTransform &
  Pick<CoordinateSystemElementV1, "kind" | "origin"> & {
    readonly axes: readonly PointV1[];
  };

type TableAnchorTarget = AnchorTransform &
  Pick<TableElementV1, "columns" | "columnWidth" | "height" | "kind" | "x" | "y">;

type LinearAnchorTarget = AnchorTransform &
  Pick<Extract<LinearElementV1, { kind: "arrow" | "line" }>, "end" | "kind" | "start">;

type PolygonAnchorTarget = Extract<
  BoxShapeElementV1,
  { kind: "diamond" | "octagon" | "parallelogram" | "triangle" }
>;

export type AnchorTargetView =
  BoxAnchorTarget | CoordinateAnchorTarget | LinearAnchorTarget | TableAnchorTarget;

export interface ResolvedShapeAnchor {
  anchor: ShapeAnchorV1;
  point: PointV1;
  order: number;
}

export function isAnchorTarget<Element extends Pick<InkElementV1, "kind">>(
  element: Element,
): element is Element & AnchorTargetView {
  return (
    element.kind === "rectangle" ||
    element.kind === "ellipse" ||
    element.kind === "triangle" ||
    element.kind === "octagon" ||
    element.kind === "parallelogram" ||
    element.kind === "diamond" ||
    element.kind === "coordinate-system" ||
    element.kind === "line" ||
    element.kind === "arrow" ||
    element.kind === "table"
  );
}

const BOX_POSITIONS: readonly BoxAnchorV1[] = [
  "top-left",
  "top-center",
  "top-right",
  "middle-right",
  "bottom-right",
  "bottom-center",
  "bottom-left",
  "middle-left",
];
const CARDINAL_ANGLES = [0, 90, 180, 270] as const;

type LocalAnchorVisitor = (point: PointV1, kind: ShapeAnchorV1["kind"], index: number) => boolean;

export function semanticAnchors(target: AnchorTargetView): ResolvedShapeAnchor[] {
  const resolved: ResolvedShapeAnchor[] = [];
  visitLocalAnchorPoints(target, (local, kind, index) => {
    resolved.push({
      anchor: anchorIdentifier(kind, index),
      point: canonicalPoint(rotatePointClockwise(local, target.pivot, target.rotation)),
      order: resolved.length,
    });
    return false;
  });
  return resolved;
}

export function resolveShapeAnchor(
  target: AnchorTargetView,
  anchor: ShapeAnchorV1,
): PointV1 | null {
  const unrotated = resolveUnrotatedAnchor(target, anchor);
  if (unrotated === null) return null;
  return canonicalPoint(rotatePointClockwise(unrotated, target.pivot, target.rotation));
}

/** Visits in semantic order and stops at the first accepted point without building anchor DTOs. */
export function visitLocalAnchorPoints(
  target: AnchorTargetView,
  visit: LocalAnchorVisitor,
): boolean {
  if (target.kind === "line" || target.kind === "arrow") {
    return visit(target.start, "linear-endpoint", 0) || visit(target.end, "linear-endpoint", 1);
  }
  if (target.kind === "rectangle" || target.kind === "table") {
    const points = boxAnchorPoints(target);
    return BOX_POSITIONS.some((position, index) => visit(points[position], "box", index));
  }
  if (target.kind === "ellipse") {
    return CARDINAL_ANGLES.some((angle, index) =>
      visit(resolveEllipseAnchor(target, angle), "ellipse-cardinal", index),
    );
  }
  if (target.kind === "coordinate-system") {
    return (
      visit(target.origin, "coordinate-origin", 0) ||
      target.axes.some((point, index) => visit(point, "coordinate-axis-end", index))
    );
  }
  return isPolygonAnchorTarget(target) && visitPolygonAnchorPoints(target, visit);
}

function visitPolygonAnchorPoints(target: PolygonAnchorTarget, visit: LocalAnchorVisitor): boolean {
  const vertices = shapeVertices(target);
  if (vertices.some((point, index) => visit(point, "polygon-vertex", index))) return true;
  return vertices.some((point, index) =>
    visit(
      midpoint(point, vertices[(index + 1) % vertices.length]!),
      "polygon-edge-midpoint",
      index,
    ),
  );
}

function anchorIdentifier(kind: ShapeAnchorV1["kind"], index: number): ShapeAnchorV1 {
  if (kind === "linear-endpoint") return { kind, endpoint: index === 0 ? "start" : "end" };
  if (kind === "box") return { kind, position: BOX_POSITIONS[index]! };
  if (kind === "ellipse-cardinal") return { kind, angle: CARDINAL_ANGLES[index]! };
  if (kind === "coordinate-origin") return { kind };
  return { kind, index };
}

function resolveUnrotatedAnchor(target: AnchorTargetView, anchor: ShapeAnchorV1): PointV1 | null {
  if (anchor.kind === "linear-endpoint") {
    return target.kind === "line" || target.kind === "arrow" ? target[anchor.endpoint] : null;
  }
  if (anchor.kind === "coordinate-origin") {
    return target.kind === "coordinate-system" ? target.origin : null;
  }
  if (anchor.kind === "coordinate-axis-end") {
    return target.kind === "coordinate-system" ? (target.axes[anchor.index] ?? null) : null;
  }
  if (anchor.kind === "box") {
    if (target.kind !== "rectangle" && target.kind !== "table") return null;
    return resolveBoxAnchor(target, anchor.position);
  }
  if (anchor.kind === "ellipse-cardinal") {
    return target.kind === "ellipse" ? resolveEllipseAnchor(target, anchor.angle) : null;
  }
  if (!isPolygonAnchorTarget(target)) return null;

  const vertices = shapeVertices(target);
  const vertex = vertices[anchor.index];
  if (vertex === undefined) return null;
  if (anchor.kind === "polygon-vertex") return vertex;
  const next = vertices[(anchor.index + 1) % vertices.length];
  return next === undefined ? null : midpoint(vertex, next);
}

function isPolygonAnchorTarget(target: AnchorTargetView): target is PolygonAnchorTarget {
  return (
    target.kind === "triangle" ||
    target.kind === "octagon" ||
    target.kind === "parallelogram" ||
    target.kind === "diamond"
  );
}

function resolveBoxAnchor(
  target: TableAnchorTarget | BoxAnchorTarget,
  position: BoxAnchorV1,
): PointV1 {
  return boxAnchorPoints(target)[position];
}

function boxAnchorPoints(
  target: TableAnchorTarget | BoxAnchorTarget,
): Record<BoxAnchorV1, PointV1> {
  const width = target.kind === "table" ? tableWidth(target) : target.width;
  const left = target.x;
  const centerX = left + width / 2;
  const right = left + width;
  const top = target.y;
  const centerY = top + target.height / 2;
  const bottom = top + target.height;
  return {
    "top-left": { x: left, y: top },
    "top-center": { x: centerX, y: top },
    "top-right": { x: right, y: top },
    "middle-right": { x: right, y: centerY },
    "bottom-right": { x: right, y: bottom },
    "bottom-center": { x: centerX, y: bottom },
    "bottom-left": { x: left, y: bottom },
    "middle-left": { x: left, y: centerY },
  };
}

function resolveEllipseAnchor(ellipse: BoxAnchorTarget, angle: 0 | 90 | 180 | 270): PointV1 {
  const center = { x: ellipse.x + ellipse.width / 2, y: ellipse.y + ellipse.height / 2 };
  if (angle === 0) return { x: ellipse.x + ellipse.width, y: center.y };
  if (angle === 90) return { x: center.x, y: ellipse.y + ellipse.height };
  if (angle === 180) return { x: ellipse.x, y: center.y };
  return { x: center.x, y: ellipse.y };
}
