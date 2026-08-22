import { describe, expect, it } from "vitest";

import {
  resolveShapeAnchor,
  semanticAnchorOrder,
  semanticAnchors,
} from "../../../../src/domain/geometry/public";
import { coordinateSystem, rectangle, table } from "./fixtures";

describe("semantic shape anchors", () => {
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

  it("returns deterministic order only for valid compatible anchors", () => {
    const diamond = rectangle({ kind: "diamond" });
    expect(semanticAnchorOrder(diamond, { kind: "polygon-edge-midpoint", index: 2 })).toBe(6);
    expect(semanticAnchorOrder(diamond, { kind: "box", position: "top-left" })).toBeNull();
  });
});
