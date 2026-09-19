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
  rotateVectorClockwise,
  roundCanonical,
  scalePoint,
  subtractPoints,
} from "./primitives";

type ClosedShapeKind = BoxShapeElementV1["kind"];

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
  const width = roundCanonical(Math.abs(end.x - start.x));
  const height = roundCanonical(Math.abs(end.y - start.y));
  return { x, y, width, height, pivot: canonicalPoint({ x: x + width / 2, y: y + height / 2 }) };
}

export function createLinearGeometry(start: PointV1, end: PointV1): LinearGeometry {
  const canonicalStart = canonicalPoint(start);
  const canonicalEnd = canonicalPoint(end);
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
  const xVector = { x: end.x - start.x, y: 0 };
  const yVector = { x: 0, y: end.y - start.y };
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
  const columnWidth = roundCanonical(Math.abs(end.x - start.x) / columns);
  const width = columns * columnWidth;
  const height = roundCanonical(Math.abs(end.y - start.y));
  const x = roundCanonical(end.x >= start.x ? start.x : start.x - width);
  const y = roundCanonical(end.y >= start.y ? start.y : start.y - height);
  const headerHeight = defaultTableHeaderHeight(height);
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
  const columnOffsets = changedTableColumnOffsets(table, newColumns);
  const { columnOffsets: _columnOffsets, ...base } = table;
  return {
    ...base,
    columns: newColumns,
    ...(columnOffsets === undefined ? {} : { columnOffsets }),
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

export function defaultTableHeaderHeight(height: number): number {
  const rounded = roundCanonical(Math.min(Math.max(24, height * 0.25), height / 2));
  return rounded > height / 2 ? roundCanonical(rounded - 0.001) : rounded;
}

export function tableColumnOffsets(
  table: Pick<TableElementV1, "columnOffsets" | "columnWidth" | "columns">,
): readonly number[] {
  return (
    table.columnOffsets ??
    Array.from({ length: Math.max(0, table.columns - 1) }, (_, index) =>
      roundCanonical((index + 1) * table.columnWidth),
    )
  );
}

export function tableLineSegments(
  table: Pick<TableElementV1, "columnWidth" | "columns" | "headerHeight" | "height" | "x" | "y">,
): readonly (readonly [PointV1, PointV1])[] {
  const right = table.x + tableWidth(table);
  const bottom = table.y + table.height;
  const segments: Array<readonly [PointV1, PointV1]> = [
    [
      { x: table.x, y: table.y + table.headerHeight },
      { x: right, y: table.y + table.headerHeight },
    ],
  ];
  for (const offset of tableColumnOffsets(table)) {
    const x = table.x + offset;
    segments.push([
      { x, y: table.y },
      { x, y: bottom },
    ]);
  }
  return segments;
}

function changedTableColumnOffsets(
  table: TableElementV1,
  newColumns: number,
): number[] | undefined {
  if (table.columnOffsets === undefined) return undefined;
  const offsets = tableColumnOffsets(table)
    .filter((offset) => offset <= newColumns * table.columnWidth)
    .slice(0, Math.max(0, newColumns - 1));
  for (let column = offsets.length + 1; column < newColumns; column += 1) {
    offsets.push(roundCanonical(column * table.columnWidth));
  }
  return offsets.every((offset, index) => offset === (index + 1) * table.columnWidth)
    ? undefined
    : offsets;
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
    const rx = width === 0 ? 0 : inset / width;
    const ry = height === 0 ? 0 : inset / height;
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
