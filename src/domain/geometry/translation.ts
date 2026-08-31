import type {
  CoordinateSystemElementV1,
  InkElementV1,
  LinearElementV1,
  PointV1,
  StrokeElementV1,
} from "../schema/types";

import { addPoints, canonicalPoint } from "./primitives";

export function translateElementGeometry(
  element: InkElementV1,
  translation: Readonly<PointV1>,
): InkElementV1 {
  if (translation.x === 0 && translation.y === 0) return element;
  if (element.kind === "stroke") return translateStroke(element, translation);
  if (
    element.kind === "line" ||
    element.kind === "arrow" ||
    element.kind === "straight-highlighter"
  ) {
    return translateLinear(element, translation);
  }
  if (element.kind === "coordinate-system") {
    return translateCoordinateSystem(element, translation);
  }
  const pivot = translatePoint(element.pivot, translation);
  return {
    ...element,
    pivot,
    x: canonicalPoint({ x: element.x + translation.x, y: element.y }).x,
    y: canonicalPoint({ x: element.x, y: element.y + translation.y }).y,
  };
}

function translateStroke(
  element: StrokeElementV1,
  translation: Readonly<PointV1>,
): StrokeElementV1 {
  const points =
    element.points instanceof Float64Array ? new Float64Array(element.points) : [...element.points];
  for (let index = 0; index < points.length; index += 3) {
    points[index] = canonicalPoint({ x: points[index]! + translation.x, y: 0 }).x;
    points[index + 1] = canonicalPoint({ x: 0, y: points[index + 1]! + translation.y }).y;
  }
  return {
    ...element,
    pivot: translatePoint(element.pivot, translation),
    points: points as StrokeElementV1["points"],
  };
}

function translateLinear(
  element: LinearElementV1,
  translation: Readonly<PointV1>,
): LinearElementV1 {
  return {
    ...element,
    bend: element.bend === null ? null : translatePoint(element.bend, translation),
    end: translatePoint(element.end, translation),
    pivot: translatePoint(element.pivot, translation),
    start: translatePoint(element.start, translation),
  };
}

function translateCoordinateSystem(
  element: CoordinateSystemElementV1,
  translation: Readonly<PointV1>,
): CoordinateSystemElementV1 {
  const axes = element.axes.map((point) => translatePoint(point, translation));
  const common = {
    ...element,
    origin: translatePoint(element.origin, translation),
    pivot: translatePoint(element.pivot, translation),
  };
  if (element.dimension === "2d") {
    return { ...common, axes: [axes[0]!, axes[1]!], dimension: "2d" };
  }
  return {
    ...common,
    axes: [axes[0]!, axes[1]!, axes[2]!],
    dimension: "3d",
  };
}

function translatePoint(point: PointV1, translation: Readonly<PointV1>): PointV1 {
  return canonicalPoint(addPoints(point, translation));
}
