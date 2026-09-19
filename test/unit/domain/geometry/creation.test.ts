import { describe, expect, it } from "vitest";

import {
  changeCoordinateSystemDimension,
  changeTableColumns,
  createClosedShapeGeometry,
  createCoordinateSystemGeometry,
  createLinearGeometry,
  createTableGeometry,
  resolveShapeAnchor,
} from "../../../../src/domain/geometry/public";
import { shapeVertices } from "../../../../src/domain/geometry/creation";
import { coordinateSystem, rectangle, table } from "./fixtures";

describe("element geometry creation", () => {
  it("normalizes closed-shape drags without inflating a collapsed dimension", () => {
    expect(createClosedShapeGeometry({ x: 10, y: 20 }, { x: 5, y: 20 })).toEqual({
      x: 5,
      y: 20,
      width: 5,
      height: 0,
      pivot: { x: 7.5, y: 20 },
    });
  });

  it("preserves short and zero-length linear drags", () => {
    expect(createLinearGeometry({ x: 1, y: 2 }, { x: 1, y: 2 }).end).toEqual({ x: 1, y: 2 });
    const diagonal = createLinearGeometry({ x: 0, y: 0 }, { x: 3, y: 4 });
    expect(diagonal.end).toEqual({ x: 3, y: 4 });
    expect(diagonal.pivot).toEqual({ x: 1.5, y: 2 });
  });

  it("rounds tiny drags only to canonical precision", () => {
    expect(createLinearGeometry({ x: 0, y: 0 }, { x: 0.001, y: -0.002 })).toMatchObject({
      end: { x: 0.001, y: -0.002 },
    });
  });

  it("creates two- and three-dimensional coordinate systems deterministically", () => {
    const twoDimensional = createCoordinateSystemGeometry({ x: 10, y: 10 }, { x: 10, y: 10 }, "2d");
    expect(twoDimensional.axes).toEqual([
      { x: 10, y: 10 },
      { x: 10, y: 10 },
    ]);
    const threeDimensional = createCoordinateSystemGeometry(
      { x: 10, y: 10 },
      { x: 10, y: 10 },
      "3d",
    );
    expect(threeDimensional.axes[2]).toEqual({ x: 10, y: 10 });
  });

  it("changes coordinate-system dimension without mutating existing endpoints", () => {
    const threeDimensional = changeCoordinateSystemDimension(coordinateSystem(), "3d");
    expect(threeDimensional.dimension).toBe("3d");
    expect(threeDimensional.axes[2]).toEqual({ x: 50, y: 150 });
    expect(changeCoordinateSystemDimension(threeDimensional, "3d")).toBe(threeDimensional);
    expect(changeCoordinateSystemDimension(threeDimensional, "2d").axes).toHaveLength(2);
  });
});

describe("table geometry creation", () => {
  it("creates tables with one canonical column width in every drag direction", () => {
    expect(createTableGeometry({ x: 200, y: 200 }, { x: 80, y: 100 }, 3)).toEqual({
      x: 80,
      y: 100,
      columnWidth: 40,
      height: 100,
      columns: 3,
      headerHeight: 25,
      pivot: { x: 140, y: 150 },
    });
    expect(() => createTableGeometry({ x: 0, y: 0 }, { x: 1, y: 1 }, 13)).toThrow(RangeError);
  });

  it("keeps tiny and collapsed tables inside the drag bounds", () => {
    expect(createTableGeometry({ x: 10, y: 20 }, { x: 10, y: 20 })).toMatchObject({
      x: 10,
      y: 20,
      columnWidth: 0,
      height: 0,
      headerHeight: 0,
      pivot: { x: 10, y: 20 },
    });
    expect(createTableGeometry({ x: 10, y: 20 }, { x: 9.997, y: 19.998 })).toMatchObject({
      x: 9.997,
      y: 19.998,
      columnWidth: 0.001,
      height: 0.002,
      headerHeight: 0.001,
    });
  });

  it("changes table columns while retaining the rendered rotated left edge", () => {
    const rotated = table({ rotation: 90 });
    const oldTop = resolveShapeAnchor(rotated, { kind: "box", position: "top-left" });
    const oldBottom = resolveShapeAnchor(rotated, { kind: "box", position: "bottom-left" });
    const changed = changeTableColumns(rotated, 5);
    expect(changed.columnWidth).toBe(50);
    expect(changed.columns).toBe(5);
    expect(resolveShapeAnchor(changed, { kind: "box", position: "top-left" })).toEqual(oldTop);
    expect(resolveShapeAnchor(changed, { kind: "box", position: "bottom-left" })).toEqual(
      oldBottom,
    );
    expect(changeTableColumns(changed, 5)).toBe(changed);
    expect(() => changeTableColumns(changed, 0)).toThrow(RangeError);
  });

  it("retains custom separators across column-count changes and restores equal spacing", () => {
    const custom = table({ columnOffsets: [60, 105] });

    const expanded = changeTableColumns(custom, 4);
    expect(expanded.columnOffsets).toEqual([60, 105, 150]);
    expect(expanded.columns).toBe(4);

    const reduced = changeTableColumns(expanded, 2);
    expect(reduced.columnOffsets).toEqual([60]);
    expect(reduced.columns).toBe(2);

    const equal = changeTableColumns(table({ columnOffsets: [50, 100] }), 4);
    expect(equal.columnOffsets).toBeUndefined();
  });

  it("retains separators placed on outer bounds across compatible column-count changes", () => {
    const boundary = table({ columnOffsets: [0, 150] });

    expect(changeTableColumns(boundary, 4).columnOffsets).toEqual([0, 150, 150]);
    expect(changeTableColumns(boundary, 2).columnOffsets).toEqual([0]);
  });
});

describe("shape geometry creation", () => {
  it("uses the specified normalized polygon vertices", () => {
    expect(shapeVertices(rectangle({ kind: "triangle" }))).toEqual([
      { x: 50, y: 0 },
      { x: 100, y: 50 },
      { x: 0, y: 50 },
    ]);
    expect(shapeVertices(rectangle({ kind: "parallelogram" }))[0]).toEqual({ x: 20, y: 0 });
    expect(shapeVertices(rectangle({ kind: "octagon" }))[0]).toEqual({ x: 14.65, y: 0 });
    expect(shapeVertices(rectangle({ kind: "octagon", width: 0, height: 0 }))).toEqual(
      Array.from({ length: 8 }, () => ({ x: 0, y: 0 })),
    );
  });
});
