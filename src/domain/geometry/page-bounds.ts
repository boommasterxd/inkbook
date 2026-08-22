import type {
  CoordinateSystemElementV1,
  InkElementV1,
  LinearElementV1,
  PointV1,
  StrokeElementV1,
} from "../schema/public";

import { boundsCorrection, calculateElementBounds } from "./bounds";
import { PAGE_WIDTH, addPoints, canonicalPoint, unionBounds, type Bounds } from "./primitives";

export type PageBoundsCorrectionResult =
  | {
      readonly correction: Readonly<PointV1>;
      readonly elements: readonly InkElementV1[];
      readonly status: "accepted";
    }
  | {
      readonly reason: "width-exceeded" | "canonical-correction-failed";
      readonly status: "rejected";
    };

const MAX_CANONICAL_CORRECTION_PASSES = 3;

export function correctElementsToPageBounds(
  elements: readonly InkElementV1[],
): PageBoundsCorrectionResult {
  if (elements.length === 0) {
    return { correction: Object.freeze({ x: 0, y: 0 }), elements, status: "accepted" };
  }
  let corrected = elements;
  let total = { x: 0, y: 0 };
  for (let pass = 0; pass < MAX_CANONICAL_CORRECTION_PASSES; pass += 1) {
    const correction = canonicalPageBoundsCorrection(combinedBounds(corrected));
    if (correction === null) return { reason: "width-exceeded", status: "rejected" };
    if (correction.x === 0 && correction.y === 0) {
      return {
        correction: Object.freeze(canonicalPoint(total)),
        elements: Object.freeze([...corrected]),
        status: "accepted",
      };
    }
    corrected = corrected.map((element) => translateElementGeometry(element, correction));
    total = addPoints(total, correction);
  }
  return { reason: "canonical-correction-failed", status: "rejected" };
}

export function canonicalPageBoundsCorrection(bounds: Readonly<Bounds>): PointV1 | null {
  const correction = boundsCorrection(bounds);
  if (correction === null) return null;
  return {
    x: roundAwayFromZero(correction.x),
    y: roundAwayFromZero(correction.y),
  };
}

function roundAwayFromZero(value: number): number {
  if (value === 0) return 0;
  const scaled = value * 1_000;
  return (value > 0 ? Math.ceil(scaled) : Math.floor(scaled)) / 1_000;
}

export function assertElementsWithinPageBounds(elements: readonly InkElementV1[]): void {
  const result = correctElementsToPageBounds(elements);
  if (result.status === "rejected" || result.correction.x !== 0 || result.correction.y !== 0) {
    throw new RangeError("Conservative element bounds must remain within the supported page.");
  }
}

export function isWithinPageBounds(bounds: Readonly<Bounds>): boolean {
  return bounds.minX >= 0 && bounds.maxX <= PAGE_WIDTH && bounds.minY >= 0;
}

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
  if (element.kind === "straight-highlighter") {
    return {
      ...element,
      end: translatePoint(element.end, translation),
      pivot: translatePoint(element.pivot, translation),
      start: translatePoint(element.start, translation),
    };
  }
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

function combinedBounds(elements: readonly InkElementV1[]): Bounds {
  let bounds = calculateElementBounds(elements[0]!);
  for (let index = 1; index < elements.length; index += 1) {
    bounds = unionBounds(bounds, calculateElementBounds(elements[index]!));
  }
  return bounds;
}
