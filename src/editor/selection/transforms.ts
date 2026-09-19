import {
  assertFinitePoint,
  canonicalPoint,
  normalizeRotation,
  rotatePointClockwise,
  roundCanonical,
} from "../../domain/geometry/public";
import { markCanonicalStrokeReplacement } from "../../domain/elements/stroke-replacement-proof";
import type {
  CoordinateSystemElementV1,
  InkElementV1,
  LinearElementV1,
  PointV1,
  StrokeElementV1,
} from "../../domain/schema/public";
import { MAX_ABSOLUTE_COORDINATE } from "../../domain/schema/public";
import { rotateLinearElement } from "./linear-transforms";
import { isLinearElement } from "./linear-elements";

export interface ScaleFactors {
  readonly x: number;
  readonly y: number;
}

export { editLinearEndpointFromWorld } from "./linear-transforms";
export { editTableColumn, editTableHeader } from "./table-transforms";

export interface TransformSliceScheduler {
  readonly isCancelled?: () => boolean;
  readonly shouldYield: () => boolean;
  readonly yieldControl: () => Promise<void>;
}

export function moveSelection(elements: readonly InkElementV1[], delta: PointV1): InkElementV1[] {
  assertFinitePoint(delta);
  if (delta.x === 0 && delta.y === 0) return [...elements];
  const canonicalDelta = Object.freeze(canonicalPoint(delta));
  return elements.map((element) => translateElement(element, canonicalDelta));
}

export async function moveSelectionTimeSliced(
  elements: readonly InkElementV1[],
  delta: PointV1,
  scheduler: TransformSliceScheduler,
): Promise<InkElementV1[] | null> {
  assertFinitePoint(delta);
  const replacements: InkElementV1[] = [];
  const canonicalDelta = Object.freeze(canonicalPoint(delta));
  for (const element of elements) {
    if (scheduler.isCancelled?.() ?? false) return null;
    replacements.push(
      delta.x === 0 && delta.y === 0
        ? structuredClone(element)
        : translateElement(element, canonicalDelta),
    );
    if (scheduler.shouldYield()) {
      await scheduler.yieldControl();
      if (scheduler.isCancelled?.() ?? false) return null;
    }
  }
  return (scheduler.isCancelled?.() ?? false) ? null : replacements;
}

export function uniformScaleFactorFromPointers(
  anchor: PointV1,
  startPointer: PointV1,
  currentPointer: PointV1,
  minimum = 0,
): number {
  assertFinitePoint(anchor);
  assertFinitePoint(startPointer);
  assertFinitePoint(currentPointer);
  if (!Number.isFinite(minimum) || minimum < 0) {
    throw new RangeError("Minimum scale must be finite and non-negative.");
  }
  const startX = startPointer.x - anchor.x;
  const startY = startPointer.y - anchor.y;
  const denominator = startX * startX + startY * startY;
  const factor =
    denominator === 0
      ? 1
      : ((currentPointer.x - anchor.x) * startX + (currentPointer.y - anchor.y) * startY) /
        denominator;
  return Math.max(factor, minimum);
}

export function editCoordinateAxis(
  element: CoordinateSystemElementV1,
  axisIndex: number,
  point: PointV1,
): CoordinateSystemElementV1 {
  const current = element.axes[axisIndex];
  if (current === undefined) throw new RangeError("Coordinate axis index is out of range.");
  assertFinitePoint(point);
  const axes = [...element.axes] as PointV1[];
  axes[axisIndex] = canonicalPoint(point);
  return element.dimension === "2d"
    ? { ...element, axes: [axes[0]!, axes[1]!] }
    : { ...element, axes: [axes[0]!, axes[1]!, axes[2]!] };
}

export function editCoordinateOrigin(
  element: CoordinateSystemElementV1,
  point: PointV1,
): CoordinateSystemElementV1 {
  assertFinitePoint(point);
  const worldAxes = element.axes.map((axis) =>
    rotatePointClockwise(axis, element.pivot, element.rotation),
  );
  const origin = canonicalPoint(point);
  const axes = worldAxes.map((axis) =>
    canonicalPoint(rotatePointClockwise(axis, origin, -element.rotation)),
  );
  return element.dimension === "2d"
    ? { ...element, axes: [axes[0]!, axes[1]!], origin, pivot: origin }
    : { ...element, axes: [axes[0]!, axes[1]!, axes[2]!], origin, pivot: origin };
}

export function rotateSelection(
  elements: readonly InkElementV1[],
  center: PointV1,
  degrees: number,
): InkElementV1[] {
  if (!Number.isFinite(degrees)) throw new RangeError("Rotation must be finite.");
  const selectedIds = new Set(elements.map(({ id }) => id));
  return elements.map((element) => {
    if (isLinearElement(element)) {
      return rotateLinearElement(element, center, degrees, selectedIds);
    }
    const rotatedPivot = canonicalPoint(rotatePointClockwise(element.pivot, center, degrees));
    const movement = { x: rotatedPivot.x - element.pivot.x, y: rotatedPivot.y - element.pivot.y };
    const translated = translateElement(element, canonicalPoint(movement));
    return { ...translated, rotation: normalizeRotation(element.rotation + degrees) };
  });
}

function translateElement(element: InkElementV1, delta: PointV1): InkElementV1 {
  const translate = (point: PointV1): PointV1 =>
    canonicalPoint({ x: point.x + delta.x, y: point.y + delta.y });
  if (element.kind === "stroke") {
    const points =
      element.points instanceof Float64Array
        ? new Float64Array(element.points.length)
        : new Array<number>(element.points.length);
    const deltaX = Math.round(delta.x * 1000);
    const deltaY = Math.round(delta.y * 1000);
    for (let index = 0; index < element.points.length; index += 3) {
      points[index] = translateCanonicalCoordinate(element.points[index] as number, deltaX);
      points[index + 1] = translateCanonicalCoordinate(element.points[index + 1] as number, deltaY);
      points[index + 2] = element.points[index + 2] as number;
    }
    const pivot = translate(element.pivot);
    assertSupportedCoordinate(pivot.x);
    assertSupportedCoordinate(pivot.y);
    const replacement: StrokeElementV1 = {
      ...element,
      points: points as unknown as StrokeElementV1["points"],
      pivot,
    };
    if (!(points instanceof Float64Array)) Object.freeze(points);
    Object.freeze(replacement.pivot);
    Object.freeze(replacement);
    return markCanonicalStrokeReplacement(element, replacement, delta);
  }
  if (element.kind === "straight-highlighter") {
    return {
      ...element,
      start: translate(element.start),
      end: translate(element.end),
      bend: element.bend === null ? null : translate(element.bend),
      pivot: translate(element.pivot),
    };
  }
  if (element.kind === "line" || element.kind === "arrow") {
    return {
      ...element,
      start: shouldTransformEndpoint(element, "start") ? translate(element.start) : element.start,
      end: shouldTransformEndpoint(element, "end") ? translate(element.end) : element.end,
      bend: element.bend === null ? null : translate(element.bend),
      pivot: translate(element.pivot),
    };
  }
  if (element.kind === "coordinate-system") {
    const axes = element.axes.map(translate);
    return element.dimension === "2d"
      ? {
          ...element,
          origin: translate(element.origin),
          axes: [axes[0]!, axes[1]!],
          pivot: translate(element.pivot),
        }
      : {
          ...element,
          origin: translate(element.origin),
          axes: [axes[0]!, axes[1]!, axes[2]!],
          pivot: translate(element.pivot),
        };
  }
  const x = roundCanonical(element.x + delta.x);
  const y = roundCanonical(element.y + delta.y);
  if (element.kind === "table") {
    return {
      ...element,
      x,
      y,
      pivot: canonicalPoint({
        x: x + (element.columns * element.columnWidth) / 2,
        y: y + element.height / 2,
      }),
    };
  }
  return {
    ...element,
    x,
    y,
    pivot: canonicalPoint({ x: x + element.width / 2, y: y + element.height / 2 }),
  };
}

function translateCanonicalCoordinate(value: number, deltaThousandths: number): number {
  const translated = (Math.round(value * 1000) + deltaThousandths) / 1000;
  const canonical = Object.is(translated, -0) ? 0 : translated;
  assertSupportedCoordinate(canonical);
  return canonical;
}

function assertSupportedCoordinate(value: number): void {
  if (Math.abs(value) > MAX_ABSOLUTE_COORDINATE) {
    throw new RangeError("Transformed stroke coordinates exceed the supported range.");
  }
}

export function scaleElement(
  element: InkElementV1,
  anchor: PointV1,
  factors: ScaleFactors,
  translation: PointV1 = { x: 0, y: 0 },
): InkElementV1 {
  const scale = (point: PointV1): PointV1 =>
    canonicalPoint({
      x: anchor.x + (point.x - anchor.x) * factors.x + translation.x,
      y: anchor.y + (point.y - anchor.y) * factors.y + translation.y,
    });
  if (element.kind === "stroke") {
    const points = element.points.map((value, index) => {
      if (index % 3 === 2) return value;
      const origin = index % 3 === 0 ? anchor.x : anchor.y;
      const factor = index % 3 === 0 ? factors.x : factors.y;
      const shift = index % 3 === 0 ? translation.x : translation.y;
      return roundCanonical(origin + (value - origin) * factor + shift);
    });
    return { ...element, points, pivot: scale(element.pivot) };
  }
  if (element.kind === "straight-highlighter") {
    return {
      ...element,
      start: scale(element.start),
      end: scale(element.end),
      bend: element.bend === null ? null : scale(element.bend),
      pivot: scale(element.pivot),
    };
  }
  if (element.kind === "line" || element.kind === "arrow") {
    return {
      ...element,
      start: shouldTransformEndpoint(element, "start") ? scale(element.start) : element.start,
      end: shouldTransformEndpoint(element, "end") ? scale(element.end) : element.end,
      bend: element.bend === null ? null : scale(element.bend),
      pivot: scale(element.pivot),
    };
  }
  if (element.kind === "coordinate-system") {
    const axes = element.axes.map(scale);
    const origin = scale(element.origin);
    return element.dimension === "2d"
      ? { ...element, origin, axes: [axes[0]!, axes[1]!], pivot: origin }
      : { ...element, origin, axes: [axes[0]!, axes[1]!, axes[2]!], pivot: origin };
  }
  if (element.kind === "table") {
    const topLeft = scale({ x: element.x, y: element.y });
    const columnWidth = roundCanonical(element.columnWidth * factors.x);
    const height = roundCanonical(element.height * factors.y);
    return {
      ...element,
      x: topLeft.x,
      y: topLeft.y,
      columnWidth,
      ...(element.columnOffsets === undefined
        ? {}
        : {
            columnOffsets: element.columnOffsets.map((offset) =>
              roundCanonical(offset * factors.x),
            ),
          }),
      height,
      headerHeight: roundCanonical(element.headerHeight * factors.y),
      pivot: canonicalPoint({
        x: topLeft.x + (element.columns * columnWidth) / 2,
        y: topLeft.y + height / 2,
      }),
    };
  }
  const topLeft = scale({ x: element.x, y: element.y });
  const width = roundCanonical(element.width * factors.x);
  const height = roundCanonical(element.height * factors.y);
  return {
    ...element,
    x: topLeft.x,
    y: topLeft.y,
    width,
    height,
    pivot: canonicalPoint({ x: topLeft.x + width / 2, y: topLeft.y + height / 2 }),
  };
}

function shouldTransformEndpoint(element: LinearElementV1, endpoint: "start" | "end"): boolean {
  if (element.kind === "straight-highlighter") return true;
  return endpoint === "start" ? element.startConnection === null : element.endConnection === null;
}
