import type {
  ArrowElementV1,
  LineElementV1,
  StraightHighlighterElementV1,
} from "../../../../src/domain/schema/public";
import { describe, expect, it } from "vitest";

import {
  arrowNodeGeometry,
  buildClosedShapePath,
  buildCoordinateSystemPath,
  buildElementPathParts,
  buildLinearPathParts,
  buildTablePath,
  linearEndpointDirections,
  nodeSize,
  outlineDashPattern,
} from "../../../../src/domain/geometry/public";
import { coordinateSystem, outlineStyle, rectangle, strokeStyle, table } from "./fixtures";

const linearBase = {
  id: "00000000-0000-4000-8000-000000000004",
  createdAt: 0,
  start: { x: 0, y: 0 },
  end: { x: 100, y: 0 },
  bend: null,
  rotation: 0,
  pivot: { x: 50, y: 0 },
  startConnection: null,
  endConnection: null,
  style: outlineStyle,
};

describe("SVG element path construction", () => {
  it("bakes polygon and ellipse rotation into path coordinates", () => {
    const triangle = buildClosedShapePath(rectangle({ kind: "triangle", rotation: 90 }));
    expect(triangle).toBe("M75 25L25 75L25-25Z");
    const ellipse = buildClosedShapePath(rectangle({ kind: "ellipse", rotation: 30 }));
    expect(ellipse).toContain("C");
    expect(ellipse).not.toContain("transform");
    expect(ellipse.endsWith("Z")).toBe(true);
  });

  it("emits tables and coordinate systems as compound paths", () => {
    const tablePath = buildTablePath(table());
    expect(tablePath.match(/M/g)).toHaveLength(3);
    expect(tablePath).not.toContain("Z");
    expect(tablePath).not.toContain("M10 20");
    const customTablePath = buildTablePath(table({ columnOffsets: [60, 105] }));
    expect(customTablePath).toContain("M70 20L70 120");
    expect(customTablePath).toContain("M115 20L115 120");
    const systemPath = buildCoordinateSystemPath(coordinateSystem());
    expect(systemPath.match(/M/g)).toHaveLength(4);
  });
});

describe("linear path construction", () => {
  it("constructs quadratic bodies and separates filled arrow nodes", () => {
    const arrow: ArrowElementV1 = {
      ...linearBase,
      kind: "arrow",
      bend: { x: 50, y: 50 },
      startNode: "arrow",
      endNode: "diamond",
    };
    const parts = buildLinearPathParts(arrow);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ paint: "stroke" });
    expect(parts[0]?.d).toContain("Q50 50 100 0");
    expect(parts[1]).toMatchObject({ paint: "fill" });
    expect(parts[1]?.d.endsWith("Z")).toBe(true);
  });

  it("renders a bent straight highlighter through the quadratic linear path", () => {
    const highlighter: StraightHighlighterElementV1 = {
      bend: { x: 50, y: 50 },
      createdAt: 0,
      end: { x: 100, y: 0 },
      endNode: "none",
      id: "highlighter",
      kind: "straight-highlighter",
      pivot: { x: 50, y: 0 },
      rotation: 0,
      start: { x: 0, y: 0 },
      startNode: "none",
      style: strokeStyle,
    };

    expect(buildLinearPathParts(highlighter)).toEqual([{ d: "M0 0Q50 50 100 0", paint: "stroke" }]);
  });

  it("falls back to the non-degenerate chord for degenerate quadratic endpoint tangents", () => {
    expect(linearEndpointDirections({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 0 })).toEqual({
      start: { x: -1, y: 0 },
      end: { x: 1, y: 0 },
    });
    expect(linearEndpointDirections({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0 })).toEqual({
      start: { x: -1, y: 0 },
      end: { x: 1, y: 0 },
    });
  });

  it("rejects a zero-length chord even when a bend provides a non-zero tangent", () => {
    expect(() =>
      linearEndpointDirections({ x: 10, y: 10 }, { x: 10, y: 10 }, { x: 20, y: 20 }),
    ).toThrow("Linear geometry must be non-degenerate.");
  });

  it("constructs every endpoint node from outward direction", () => {
    expect(arrowNodeGeometry({ x: 10, y: 0 }, { x: 1, y: 0 }, "none", 12)).toEqual({
      kind: "none",
    });
    const open = arrowNodeGeometry({ x: 10, y: 0 }, { x: 1, y: 0 }, "arrow", 12);
    expect(open.kind).toBe("open");
    const triangle = arrowNodeGeometry({ x: 10, y: 0 }, { x: 1, y: 0 }, "triangle", 12);
    expect(triangle.kind === "polygon" ? triangle.points : []).toHaveLength(3);
    const diamond = arrowNodeGeometry({ x: 10, y: 0 }, { x: 1, y: 0 }, "diamond", 12);
    expect(diamond.kind === "polygon" ? diamond.points : []).toHaveLength(4);
    const circle = arrowNodeGeometry({ x: 10, y: 0 }, { x: 1, y: 0 }, "circle", 12);
    expect(circle).toEqual({ kind: "circle", center: { x: 4, y: 0 }, radius: 6 });
    expect(() => arrowNodeGeometry({ x: 0, y: 0 }, { x: 0, y: 0 }, "arrow", 12)).toThrow(
      RangeError,
    );
  });

  it("encodes exact node sizes and outline dash patterns", () => {
    expect(nodeSize(2)).toBe(12);
    expect(nodeSize(8)).toBe(32);
    expect(outlineDashPattern("solid", 4)).toBeNull();
    expect(outlineDashPattern("dashed", 4)).toEqual([16, 12]);
    expect(outlineDashPattern("dotted", 4)).toEqual([0, 10]);
  });

  it("routes every element kind to the appropriate path semantics", () => {
    const line: LineElementV1 = { ...linearBase, kind: "line", startNode: "none", endNode: "none" };
    expect(buildElementPathParts(line)).toEqual([{ d: "M0 0L100 0", paint: "stroke" }]);
    expect(buildElementPathParts(table())[0]?.paint).toBe("stroke");
    expect(buildElementPathParts(rectangle())[0]?.paint).toBe("fill-and-stroke");
  });
});
