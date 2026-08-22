import { describe, expect, it } from "vitest";

import {
  changeTableColumns,
  pointDistance,
  rotatePointClockwise,
} from "../../../../src/domain/geometry/public";
import type { PointV1, TableElementV1 } from "../../../../src/domain/schema/public";
import { validateInkElementV1 } from "../../../../src/domain/schema/public";
import { table } from "./fixtures";

const FIXED_EDGE_TOLERANCE = 0.003;
const FIRST_ROTATION_MILLIDEGREES = -180_000;
const LAST_ROTATION_MILLIDEGREES = 180_000;

describe("table column changes", () => {
  it("retains the rendered left edge across the complete canonical rotation range", () => {
    let maximumLeftDrift = 0;
    let maximumRightTranslationError = 0;
    let structuralPropertiesRetained = true;

    for (
      let millidegrees = FIRST_ROTATION_MILLIDEGREES;
      millidegrees < LAST_ROTATION_MILLIDEGREES;
      millidegrees += 1
    ) {
      const rotation = millidegrees / 1000;
      const initial = fractionalTable(rotation);
      const added = changeTableColumns(initial, 12);
      const removed = changeTableColumns(added, 1);
      structuralPropertiesRetained &&= added.columns === 12 && removed.columns === 1;
      for (const [before, after] of [
        [initial, added],
        [added, removed],
      ] as const) {
        const measurement = measureEdgeChange(before, after);
        maximumLeftDrift = Math.max(maximumLeftDrift, measurement.leftDrift);
        maximumRightTranslationError = Math.max(
          maximumRightTranslationError,
          measurement.rightTranslationError,
        );
        structuralPropertiesRetained &&= retainsStructuralProperties(before, after);
      }
    }

    expect(maximumLeftDrift).toBeLessThanOrEqual(FIXED_EDGE_TOLERANCE);
    expect(maximumRightTranslationError).toBeLessThanOrEqual(FIXED_EDGE_TOLERANCE);
    expect(structuralPropertiesRetained).toBe(true);
  });

  it("supports the minimum column count and rejects values outside the structural range", () => {
    const source = fractionalTable(179.999);
    const minimum = changeTableColumns(source, 1);

    expect(minimum.columns).toBe(1);
    expect(minimum.columnWidth).toBe(source.columnWidth);
    expect(changeTableColumns(minimum, 1)).toBe(minimum);
    expect(() => changeTableColumns(source, 0)).toThrow(RangeError);
    expect(() => changeTableColumns(source, 1.5)).toThrow(RangeError);
    expect(() => changeTableColumns(source, 13)).toThrow(RangeError);
  });

  it("derives the rotated result pivot from canonical table fields", () => {
    const source = table({
      x: 700.123,
      y: 400.456,
      columnWidth: 40,
      columns: 1,
      height: 80.777,
      headerHeight: 24,
      pivot: { x: 720.123, y: 440.845 },
      rotation: 43.744,
    });

    const changed = changeTableColumns(source, 4);

    expect(changed.pivot.y).toBe(482.332);
    expect(changed.pivot).toEqual({
      x: changed.x + (changed.columns * changed.columnWidth) / 2,
      y: 482.332,
    });
    expect(validateInkElementV1(changed).ok).toBe(true);
  });
});

function fractionalTable(rotation: number): TableElementV1 {
  return table({
    columnWidth: 40.333,
    columns: 3,
    headerHeight: 24.233,
    height: 80.777,
    pivot: { x: 760.623, y: 440.845 },
    rotation,
    x: 700.123,
    y: 400.456,
  });
}

function measureEdgeChange(
  before: TableElementV1,
  after: TableElementV1,
): { readonly leftDrift: number; readonly rightTranslationError: number } {
  const beforeEdges = renderedEdges(before);
  const afterEdges = renderedEdges(after);
  const widthDelta = after.columns * after.columnWidth - before.columns * before.columnWidth;
  const expectedRightShift = rotatePointClockwise(
    { x: widthDelta, y: 0 },
    { x: 0, y: 0 },
    before.rotation,
  );
  return {
    leftDrift: maximumEndpointDistance(beforeEdges.left, afterEdges.left),
    rightTranslationError: Math.max(
      pointDistance(translated(beforeEdges.right.top, expectedRightShift), afterEdges.right.top),
      pointDistance(
        translated(beforeEdges.right.bottom, expectedRightShift),
        afterEdges.right.bottom,
      ),
    ),
  };
}

function renderedEdges(tableValue: TableElementV1) {
  const left = tableValue.x;
  const right = left + tableValue.columns * tableValue.columnWidth;
  const render = (point: PointV1) =>
    rotatePointClockwise(point, tableValue.pivot, tableValue.rotation);
  return {
    left: {
      bottom: render({ x: left, y: tableValue.y + tableValue.height }),
      top: render({ x: left, y: tableValue.y }),
    },
    right: {
      bottom: render({ x: right, y: tableValue.y + tableValue.height }),
      top: render({ x: right, y: tableValue.y }),
    },
  };
}

function maximumEndpointDistance(
  before: Readonly<{ bottom: PointV1; top: PointV1 }>,
  after: Readonly<{ bottom: PointV1; top: PointV1 }>,
): number {
  return Math.max(pointDistance(before.top, after.top), pointDistance(before.bottom, after.bottom));
}

function retainsStructuralProperties(before: TableElementV1, after: TableElementV1): boolean {
  return (
    after.columnWidth === before.columnWidth &&
    after.headerHeight === before.headerHeight &&
    after.height === before.height &&
    after.rotation === before.rotation &&
    after.style === before.style
  );
}

function translated(point: PointV1, vector: PointV1): PointV1 {
  return { x: point.x + vector.x, y: point.y + vector.y };
}
