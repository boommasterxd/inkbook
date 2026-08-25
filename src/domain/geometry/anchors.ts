import type {
  BoxAnchorV1,
  BoxShapeElementV1,
  CoordinateSystemElementV1,
  PointV1,
  ShapeAnchorV1,
  TableElementV1,
  InkElementV1,
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

export type AnchorTarget = BoxShapeElementV1 | CoordinateSystemElementV1 | TableElementV1;
export type AnchorTargetView = BoxAnchorTarget | CoordinateAnchorTarget | TableAnchorTarget;

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

export function semanticAnchors(target: AnchorTargetView): ResolvedShapeAnchor[] {
  const anchors = anchorIdentifiers(target);
  const resolved: ResolvedShapeAnchor[] = [];
  for (let order = 0; order < anchors.length; order += 1) {
    const anchor = anchors[order];
    if (anchor === undefined) continue;
    const point = resolveShapeAnchor(target, anchor);
    if (point !== null) resolved.push({ anchor, point, order });
  }
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

export function semanticAnchorOrder(
  target: AnchorTargetView,
  anchor: ShapeAnchorV1,
): number | null {
  const anchors = anchorIdentifiers(target);
  const index = anchors.findIndex((candidate) => anchorsEqual(candidate, anchor));
  return index < 0 ? null : index;
}

function anchorIdentifiers(target: AnchorTargetView): ShapeAnchorV1[] {
  if (target.kind === "rectangle" || target.kind === "table") {
    return BOX_POSITIONS.map((position) => ({ kind: "box", position }));
  }
  if (target.kind === "ellipse") {
    return ([0, 90, 180, 270] as const).map((angle) => ({ kind: "ellipse-cardinal", angle }));
  }
  if (target.kind === "coordinate-system") {
    return [
      { kind: "coordinate-origin" },
      ...target.axes.map((_, index): ShapeAnchorV1 => ({ kind: "coordinate-axis-end", index })),
    ];
  }

  const vertices = shapeVertices(target);
  return [
    ...vertices.map((_, index): ShapeAnchorV1 => ({ kind: "polygon-vertex", index })),
    ...vertices.map((_, index): ShapeAnchorV1 => ({ kind: "polygon-edge-midpoint", index })),
  ];
}

function resolveUnrotatedAnchor(target: AnchorTargetView, anchor: ShapeAnchorV1): PointV1 | null {
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
  if (target.kind === "coordinate-system" || target.kind === "table") return null;
  if (target.kind === "rectangle" || target.kind === "ellipse") return null;

  const vertices = shapeVertices(target);
  const vertex = vertices[anchor.index];
  if (vertex === undefined) return null;
  if (anchor.kind === "polygon-vertex") return vertex;
  const next = vertices[(anchor.index + 1) % vertices.length];
  return next === undefined ? null : midpoint(vertex, next);
}

function resolveBoxAnchor(
  target: TableAnchorTarget | BoxAnchorTarget,
  position: BoxAnchorV1,
): PointV1 {
  const width = target.kind === "table" ? tableWidth(target) : target.width;
  const left = target.x;
  const centerX = left + width / 2;
  const right = left + width;
  const top = target.y;
  const centerY = top + target.height / 2;
  const bottom = top + target.height;
  const values: Record<BoxAnchorV1, PointV1> = {
    "top-left": { x: left, y: top },
    "top-center": { x: centerX, y: top },
    "top-right": { x: right, y: top },
    "middle-right": { x: right, y: centerY },
    "bottom-right": { x: right, y: bottom },
    "bottom-center": { x: centerX, y: bottom },
    "bottom-left": { x: left, y: bottom },
    "middle-left": { x: left, y: centerY },
  };
  return values[position];
}

function resolveEllipseAnchor(ellipse: BoxAnchorTarget, angle: 0 | 90 | 180 | 270): PointV1 {
  const center = { x: ellipse.x + ellipse.width / 2, y: ellipse.y + ellipse.height / 2 };
  if (angle === 0) return { x: ellipse.x + ellipse.width, y: center.y };
  if (angle === 90) return { x: center.x, y: ellipse.y + ellipse.height };
  if (angle === 180) return { x: ellipse.x, y: center.y };
  return { x: center.x, y: ellipse.y };
}

function anchorsEqual(left: ShapeAnchorV1, right: ShapeAnchorV1): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "box" && right.kind === "box") return left.position === right.position;
  if (left.kind === "ellipse-cardinal" && right.kind === "ellipse-cardinal") {
    return left.angle === right.angle;
  }
  if (left.kind === "polygon-vertex" && right.kind === "polygon-vertex") {
    return left.index === right.index;
  }
  if (left.kind === "polygon-edge-midpoint" && right.kind === "polygon-edge-midpoint") {
    return left.index === right.index;
  }
  if (left.kind === "coordinate-axis-end" && right.kind === "coordinate-axis-end") {
    return left.index === right.index;
  }
  return left.kind === "coordinate-origin" && right.kind === "coordinate-origin";
}
