import { describe, expect, it } from "vitest";

import {
  isAnchorTarget,
  resolveShapeAnchor,
  semanticAnchorOrder,
  semanticAnchors,
} from "../../../../src/domain/geometry/public";
import { coordinateSystem, rectangle, table } from "./fixtures";

describe("semantic anchor enumeration", () => {
  it("emits rectangle anchors in their canonical order", () => {
    const anchors = semanticAnchors(rectangle());
    expect(anchors.map((entry) => entry.anchor)).toEqual([
      { kind: "box", position: "top-left" },
      { kind: "box", position: "top-center" },
      { kind: "box", position: "top-right" },
      { kind: "box", position: "middle-right" },
      { kind: "box", position: "bottom-right" },
      { kind: "box", position: "bottom-center" },
      { kind: "box", position: "bottom-left" },
      { kind: "box", position: "middle-left" },
    ]);
    expect(anchors[3]?.point).toEqual({ x: 100, y: 25 });
  });

  it("resolves anchors after clockwise target rotation", () => {
    const target = rectangle({ rotation: 90 });
    expect(resolveShapeAnchor(target, { kind: "box", position: "top-left" })).toEqual({
      x: 75,
      y: -25,
    });
  });

  it("maps ellipse cardinal angles in page-coordinate order", () => {
    const ellipse = rectangle({ kind: "ellipse" });
    expect(semanticAnchors(ellipse).map((entry) => entry.point)).toEqual([
      { x: 100, y: 25 },
      { x: 50, y: 50 },
      { x: 0, y: 25 },
      { x: 50, y: 0 },
    ]);
    expect(resolveShapeAnchor(ellipse, { kind: "box", position: "top-left" })).toBeNull();
  });

  it("orders polygon vertices before their edge midpoints", () => {
    const triangle = rectangle({ kind: "triangle" });
    const anchors = semanticAnchors(triangle);
    expect(anchors).toHaveLength(6);
    expect(anchors[0]).toMatchObject({ anchor: { kind: "polygon-vertex", index: 0 }, order: 0 });
    expect(anchors[3]).toMatchObject({
      anchor: { kind: "polygon-edge-midpoint", index: 0 },
      order: 3,
    });
    expect(anchors[3]?.point).toEqual({ x: 75, y: 25 });
    expect(resolveShapeAnchor(triangle, { kind: "polygon-vertex", index: 3 })).toBeNull();
  });

  it("resolves table box anchors and coordinate endpoints only for compatible targets", () => {
    expect(resolveShapeAnchor(table(), { kind: "box", position: "bottom-right" })).toEqual({
      x: 160,
      y: 120,
    });
    const system = coordinateSystem("3d");
    expect(semanticAnchors(system)).toHaveLength(4);
    expect(resolveShapeAnchor(system, { kind: "coordinate-origin" })).toEqual({ x: 100, y: 100 });
    expect(resolveShapeAnchor(system, { kind: "coordinate-axis-end", index: 2 })).toEqual({
      x: 50,
      y: 150,
    });
    expect(resolveShapeAnchor(system, { kind: "coordinate-axis-end", index: 3 })).toBeNull();
    expect(resolveShapeAnchor(system, { kind: "polygon-vertex", index: 0 })).toBeNull();
  });
});

describe("semantic anchor ordering", () => {
  it("returns deterministic order only for valid compatible anchors", () => {
    const diamond = rectangle({ kind: "diamond" });
    expect(semanticAnchorOrder(diamond, { kind: "polygon-edge-midpoint", index: 2 })).toBe(6);
    expect(semanticAnchorOrder(diamond, { kind: "box", position: "top-left" })).toBeNull();
  });

  it("compares every semantic anchor identity by its category and payload", () => {
    const box = rectangle();
    expect(semanticAnchorOrder(box, { kind: "box", position: "top-left" })).toBe(0);
    expect(semanticAnchorOrder(box, { kind: "box", position: "middle-left" })).toBe(7);
    expect(semanticAnchorOrder(box, { kind: "box", position: "bottom-right" })).toBe(4);

    const ellipse = rectangle({ kind: "ellipse" });
    expect(semanticAnchorOrder(ellipse, { kind: "ellipse-cardinal", angle: 0 })).toBe(0);
    expect(semanticAnchorOrder(ellipse, { kind: "ellipse-cardinal", angle: 180 })).toBe(2);
    expect(semanticAnchorOrder(ellipse, { kind: "ellipse-cardinal", angle: 270 })).toBe(3);

    const polygon = rectangle({ kind: "diamond" });
    expect(semanticAnchorOrder(polygon, { kind: "polygon-vertex", index: 0 })).toBe(0);
    expect(semanticAnchorOrder(polygon, { kind: "polygon-vertex", index: 3 })).toBe(3);
    expect(semanticAnchorOrder(polygon, { kind: "polygon-edge-midpoint", index: 0 })).toBe(4);
    expect(semanticAnchorOrder(polygon, { kind: "polygon-edge-midpoint", index: 3 })).toBe(7);

    const system = coordinateSystem("3d");
    expect(semanticAnchorOrder(system, { kind: "coordinate-origin" })).toBe(0);
    expect(semanticAnchorOrder(system, { kind: "coordinate-axis-end", index: 0 })).toBe(1);
    expect(semanticAnchorOrder(system, { kind: "coordinate-axis-end", index: 2 })).toBe(3);
    expect(semanticAnchorOrder(system, { kind: "coordinate-axis-end", index: 5 })).toBeNull();
  });
});

describe("semantic anchor compatibility", () => {
  it("rejects incompatible anchor categories for every target family", () => {
    const box = rectangle();
    const ellipse = rectangle({ kind: "ellipse" });
    const polygon = rectangle({ kind: "triangle" });
    const system = coordinateSystem("2d");
    const targetTable = table();

    expect(resolveShapeAnchor(box, { kind: "coordinate-origin" })).toBeNull();
    expect(resolveShapeAnchor(box, { kind: "coordinate-axis-end", index: 0 })).toBeNull();
    expect(resolveShapeAnchor(box, { kind: "ellipse-cardinal", angle: 0 })).toBeNull();
    expect(resolveShapeAnchor(box, { kind: "polygon-vertex", index: 0 })).toBeNull();
    expect(resolveShapeAnchor(ellipse, { kind: "box", position: "top-left" })).toBeNull();
    expect(resolveShapeAnchor(ellipse, { kind: "polygon-edge-midpoint", index: 0 })).toBeNull();
    expect(resolveShapeAnchor(system, { kind: "polygon-vertex", index: 0 })).toBeNull();
    expect(resolveShapeAnchor(targetTable, { kind: "polygon-edge-midpoint", index: 0 })).toBeNull();
    expect(resolveShapeAnchor(polygon, { kind: "polygon-vertex", index: 99 })).toBeNull();
    expect(resolveShapeAnchor(polygon, { kind: "polygon-edge-midpoint", index: 1 })).toEqual({
      x: 50,
      y: 50,
    });
  });

  it("recognizes exactly the supported anchor target kinds", () => {
    for (const kind of [
      "rectangle",
      "ellipse",
      "triangle",
      "octagon",
      "parallelogram",
      "diamond",
      "coordinate-system",
      "table",
    ] as const) {
      expect(isAnchorTarget({ kind })).toBe(true);
    }
    expect(isAnchorTarget({ kind: "stroke" })).toBe(false);
    expect(isAnchorTarget({ kind: "line" })).toBe(false);
  });
});
