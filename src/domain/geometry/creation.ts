import type {
  BoxShapeElementV1,
  CoordinateSystemElementV1,
  PointV1,
  TableElementV1,
} from "../schema/types";
import {
  addPoints,
  canonicalPoint,
  midpoint,
  pointDistance,
  rotateVectorClockwise,
  roundCanonical,
  scalePoint,
  subtractPoints,
} from "./primitives";

type ClosedShapeKind = BoxShapeElementV1["kind"];

const MINIMUM_LINEAR_LENGTH = 8;
const CANONICAL_LINEAR_MARGIN = 0.001;

export interface ClosedShapeGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  pivot: PointV1;
}

export interface LinearGeometry {
  start: PointV1;
  end: PointV1;
  bend: null;
  pivot: PointV1;
}

export type CoordinateSystemGeometry = Pick<
  CoordinateSystemElementV1,
  "origin" | "axes" | "dimension" | "pivot"
>;

export type TableGeometry = Pick<
  TableElementV1,
  "x" | "y" | "columnWidth" | "height" | "columns" | "headerHeight" | "pivot"
>;

export function createClosedShapeGeometry(start: PointV1, end: PointV1): ClosedShapeGeometry {
  const x = roundCanonical(Math.min(start.x, end.x));
  const y = roundCanonical(Math.min(start.y, end.y));
  const width = roundCanonical(Math.max(1, Math.abs(end.x - start.x)));
  const height = roundCanonical(Math.max(1, Math.abs(end.y - start.y)));
  return { x, y, width, height, pivot: canonicalPoint({ x: x + width / 2, y: y + height / 2 }) };
}

export function createLinearGeometry(start: PointV1, end: PointV1): LinearGeometry {
  const canonicalStart = canonicalPoint(start);
  const vector = subtractPoints(end, start);
  const length = pointDistance(start, end);
  const adjustedEnd =
    length === 0
      ? addPoints(canonicalStart, { x: MINIMUM_LINEAR_LENGTH, y: 0 })
      : length < MINIMUM_LINEAR_LENGTH
        ? addPoints(start, scalePoint(vector, MINIMUM_LINEAR_LENGTH / length))
        : end;
  const canonicalEnd = canonicalLinearEnd(canonicalStart, canonicalPoint(adjustedEnd), vector);
  return {
    start: canonicalStart,
    end: canonicalEnd,
    bend: null,
    pivot: canonicalPoint(midpoint(canonicalStart, canonicalEnd)),
  };
}

export function createCoordinateSystemGeometry(
  start: PointV1,
  end: PointV1,
  dimension: "2d" | "3d",
): CoordinateSystemGeometry {
  const origin = canonicalPoint(start);
  const xVector = { x: signedMinimum(end.x - start.x, 40, 200), y: 0 };
  const yVector = { x: 0, y: signedMinimum(end.y - start.y, 40, -200) };
  const first = canonicalPoint(addPoints(origin, xVector));
  const second = canonicalPoint(addPoints(origin, yVector));
  if (dimension === "2d") return { dimension, origin, axes: [first, second], pivot: origin };

  const third = thirdAxisEndpoint(origin, first, second);
  return { dimension, origin, axes: [first, second, third], pivot: origin };
}

export function changeCoordinateSystemDimension(
  element: CoordinateSystemElementV1,
  dimension: "2d" | "3d",
): CoordinateSystemElementV1 {
  if (element.dimension === dimension) return element;
  if (dimension === "2d") {
    return { ...element, dimension, axes: [element.axes[0], element.axes[1]] };
  }

  return {
    ...element,
    dimension,
    axes: [
      element.axes[0],
      element.axes[1],
      thirdAxisEndpoint(element.origin, element.axes[0], element.axes[1]),
    ],
  };
}

export function createTableGeometry(start: PointV1, end: PointV1, columns = 3): TableGeometry {
  assertColumnCount(columns);
  const columnWidth = roundCanonical(Math.max(Math.abs(end.x - start.x) / columns, 40));
  const width = columns * columnWidth;
  const height = roundCanonical(Math.max(Math.abs(end.y - start.y), 80));
  const x = roundCanonical(end.x >= start.x ? start.x : start.x - width);
  const y = roundCanonical(end.y >= start.y ? start.y : start.y - height);
  const headerHeight = roundCanonical(Math.max(24, Math.min(height * 0.3, height / 2)));
  return {
    x,
    y,
    columnWidth,
    height,
    columns,
    headerHeight,
    pivot: canonicalPoint({ x: x + width / 2, y: y + height / 2 }),
  };
}

export function changeTableColumns(table: TableElementV1, newColumns: number): TableElementV1 {
  assertColumnCount(newColumns);
  if (newColumns === table.columns) return table;
  const oldWidth = table.columns * table.columnWidth;
  const newWidth = newColumns * table.columnWidth;
  const pivotShift = rotateVectorClockwise({ x: (newWidth - oldWidth) / 2, y: 0 }, table.rotation);
  const candidatePivot = addPoints(table.pivot, pivotShift);
  const x = roundCanonical(candidatePivot.x - newWidth / 2);
  const y = roundCanonical(candidatePivot.y - table.height / 2);
  return {
    ...table,
    columns: newColumns,
    x,
    y,
    pivot: canonicalPoint({ x: x + newWidth / 2, y: y + table.height / 2 }),
  };
}

export function shapeVertices(
  shape: Pick<BoxShapeElementV1, "kind" | "x" | "y" | "width" | "height">,
): PointV1[] {
  const normalized = normalizedVertices(shape.kind, shape.width, shape.height);
  return normalized.map((point) =>
    canonicalPoint({
      x: shape.x + point.x * shape.width,
      y: shape.y + point.y * shape.height,
    }),
  );
}

export function tableWidth(table: Pick<TableElementV1, "columns" | "columnWidth">): number {
  return table.columns * table.columnWidth;
}

function signedMinimum(value: number, minimum: number, zeroDefault: number): number {
  if (value === 0) return zeroDefault;
  return Math.sign(value) * Math.max(Math.abs(value), minimum);
}

function thirdAxisEndpoint(origin: PointV1, first: PointV1, second: PointV1): PointV1 {
  const combined = addPoints(subtractPoints(first, origin), subtractPoints(second, origin));
  return canonicalPoint(addPoints(origin, scalePoint(combined, -0.5)));
}

function assertColumnCount(columns: number): void {
  if (!Number.isInteger(columns) || columns < 1 || columns > 12) {
    throw new RangeError("Table columns must be an integer from 1 through 12.");
  }
}

function canonicalLinearEnd(start: PointV1, end: PointV1, direction: PointV1): PointV1 {
  if (pointDistance(start, end) >= MINIMUM_LINEAR_LENGTH) return end;
  const length = Math.hypot(direction.x, direction.y);
  if (length === 0) return canonicalPoint(addPoints(start, { x: MINIMUM_LINEAR_LENGTH, y: 0 }));
  const safeLength = MINIMUM_LINEAR_LENGTH + CANONICAL_LINEAR_MARGIN;
  return canonicalPoint(addPoints(start, scalePoint(direction, safeLength / length)));
}

function normalizedVertices(kind: ClosedShapeKind, width: number, height: number): PointV1[] {
  if (kind === "triangle")
    return [
      { x: 0.5, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
  if (kind === "diamond") {
    return [
      { x: 0.5, y: 0 },
      { x: 1, y: 0.5 },
      { x: 0.5, y: 1 },
      { x: 0, y: 0.5 },
    ];
  }
  if (kind === "parallelogram") {
    return [
      { x: 0.2, y: 0 },
      { x: 1, y: 0 },
      { x: 0.8, y: 1 },
      { x: 0, y: 1 },
    ];
  }
  if (kind === "octagon") {
    const inset = Math.min(width, height) * 0.293;
    const rx = inset / width;
    const ry = inset / height;
    return [
      { x: rx, y: 0 },
      { x: 1 - rx, y: 0 },
      { x: 1, y: ry },
      { x: 1, y: 1 - ry },
      { x: 1 - rx, y: 1 },
      { x: rx, y: 1 },
      { x: 0, y: 1 - ry },
      { x: 0, y: ry },
    ];
  }
  return [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
}
