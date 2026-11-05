import { describe, expect, it } from "vitest";
import {
  quadraticPoint,
  pointDistance,
  rotatePointClockwise,
} from "../../../../src/domain/geometry/primitives";
import { linearEndpointDirections } from "../../../../src/domain/geometry/element-path";
import { EDGE_NODES, edgeArrowPath, edgeShaftPath, type EdgeNode } from "./edge-arrow-fixtures";
import { recognizePointPath as recognize } from "./recognition-fixtures";

function boundaryArrowsInBothOrders(node: Exclude<EdgeNode, "none">, curved = false) {
  const path = edgeArrowPath("none", node, curved);
  return [false, true].map((reverse) => {
    const result = recognize(reverse ? [...path].reverse() : path);
    expect(result).toMatchObject({
      kind: "arrow",
      startNode: reverse ? node : "none",
      endNode: reverse ? "none" : node,
    });
    if (result?.kind !== "arrow") throw new Error("Expected native arrow geometry");
    return { result, reverse };
  });
}

describe("native arrow heads attached at the near boundary", () => {
  it.each(EDGE_NODES)("keeps a %s boundary connection in both stroke orders", (node) => {
    for (const { result, reverse } of boundaryArrowsInBothOrders(node)) {
      const semanticEndpoint = reverse ? result.start : result.end;
      expect(semanticEndpoint.x).toBeCloseTo(220, 0);
      expect(semanticEndpoint.y).toBeCloseTo(0, 0);
      expect(result.pivot.x).toBeCloseTo(110, 0);
    }
  });

  it.each(EDGE_NODES)("supports %s boundary markers at the beginning and both ends", (node) => {
    for (const end of ["none", node] as const) {
      const result = recognize(edgeArrowPath(node, end));
      expect(result).toMatchObject({ kind: "arrow", startNode: node, endNode: end });
      if (result?.kind !== "arrow") throw new Error("Expected native arrow geometry");
      expect(result.start.x).toBeCloseTo(-20, 0);
      expect(result.end.x).toBeCloseTo(end === "none" ? 200 : 220, 0);
    }
  });

  it.each(EDGE_NODES)("preserves the drawn curved shaft before a %s edge marker", (node) => {
    for (const { result } of boundaryArrowsInBothOrders(node, true)) {
      if (result.bend === null) throw new Error("Expected quadratic arrow");
      const fitted = Array.from({ length: 201 }, (_, index) =>
        quadraticPoint(result.start, result.bend!, result.end, index / 200),
      );
      const visible = edgeShaftPath(true).slice(2, -2);
      for (const point of visible)
        expect(
          Math.min(...fitted.map((candidate) => pointDistance(candidate, point))),
        ).toBeLessThan(3);
    }
  });

  it("handles mixed markers on both curved ends with modest independent noise and rotation", () => {
    const path = edgeArrowPath("triangle", "diamond", true)
      .map((point, index) => ({
        x: point.x + Math.sin(index * 1.13) * 0.35,
        y: point.y + Math.cos(index * 1.37) * 0.35,
      }))
      .map((point) => rotatePointClockwise(point, { x: 100, y: 0 }, 57));
    expect(recognize(path)).toMatchObject({
      kind: "arrow",
      startNode: "triangle",
      endNode: "diamond",
    });
    expect(recognize([...path].reverse())).toMatchObject({
      kind: "arrow",
      startNode: "diamond",
      endNode: "triangle",
    });
  });

  it("rejects open loops and a side-attached loop instead of manufacturing an endpoint marker", () => {
    const full = edgeArrowPath("none", "circle");
    expect(recognize(full.slice(0, -12))?.kind).not.toBe("arrow");
    const sideAttached = edgeArrowPath("none", "circle").map((point, index) =>
      index < 81 ? point : { x: point.x - 10, y: point.y - 10 },
    );
    expect(recognize(sideAttached)?.kind).not.toBe("arrow");
  });
});

describe("arrow attachment fidelity", () => {
  it.each([false, true])(
    "preserves mixed native endpoint geometry after boundary retracing with curved=%s",
    (curved) => {
      const path = edgeArrowPath("circle", "diamond", curved);
      // Native fixtures use 40 circle spans and 32 diamond spans. Repeat only one fifth
      // of each rim, keeping the complete observed shaft between the two closed loops.
      const circleSpans = 40;
      const diamondSpans = 32;
      const overtraced = [
        ...path.slice(circleSpans - circleSpans / 5, circleSpans),
        ...path,
        ...path.slice(-diamondSpans, -diamondSpans + Math.floor(diamondSpans / 5)),
      ];
      const directions = linearEndpointDirections(
        { x: 0, y: 0 },
        { x: 200, y: 0 },
        curved ? { x: 90, y: -65 } : null,
      );
      const endpoints = [
        { x: directions.start.x * 20, y: directions.start.y * 20 },
        { x: 200 + directions.end.x * 20, y: directions.end.y * 20 },
      ];
      for (const reverse of [false, true])
        for (const zoom of [0.6140778660774231, 1]) {
          const result = recognize(reverse ? [...overtraced].reverse() : overtraced, zoom);
          expect(result).toMatchObject({
            kind: "arrow",
            startNode: reverse ? "diamond" : "circle",
            endNode: reverse ? "circle" : "diamond",
          });
          if (result?.kind !== "arrow") throw new Error("Expected native arrow geometry");
          expect(pointDistance(result.start, endpoints[reverse ? 1 : 0]!)).toBeLessThan(0.75);
          expect(pointDistance(result.end, endpoints[reverse ? 0 : 1]!)).toBeLessThan(0.75);
          expect(result.bend === null).toBe(!curved);
        }
    },
  );

  it("retains a genuine side-boundary circle when no tip or edge attachment fits", () => {
    const loop = Array.from({ length: 41 }, (_, index) => {
      const angle = Math.PI / 2 + (index * Math.PI) / 20;
      return { x: 200 + 20 * Math.cos(angle), y: -20 + 20 * Math.sin(angle) };
    });
    const path = [...edgeShaftPath(), ...loop.slice(1)];
    for (const reverse of [false, true]) {
      const result = recognize(reverse ? [...path].reverse() : path);
      expect(result).toMatchObject({
        kind: "arrow",
        startNode: reverse ? "circle" : "none",
        endNode: reverse ? "none" : "circle",
      });
      if (result?.kind !== "arrow") throw new Error("Expected native arrow geometry");
      expect(pointDistance(reverse ? result.start : result.end, { x: 220, y: -20 })).toBeLessThan(
        0.75,
      );
    }
  });

  it("does not mistake a short retraced arc on an incomplete circle for a closed marker", () => {
    const partial = edgeArrowPath("none", "circle").slice(0, -12);
    const retraced = [...partial, ...partial.slice(-6).reverse()];
    for (const reverse of [false, true])
      expect(recognize(reverse ? [...retraced].reverse() : retraced)?.kind).not.toBe("arrow");
  });
});
