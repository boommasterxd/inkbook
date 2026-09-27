import { elementContainsPoint } from "../../../../src/editor/selection/hit-test";
import { describe, expect, it } from "vitest";
import { stroke } from "../../domain/schema/fixtures";
import { transformedStrokeCenters } from "../../../../src/domain/geometry/stroke-path";
import { strokeWorldPoint } from "../../../../src/domain/geometry/stroke-position";
import { createSweptCapsuleCheck } from "../../../../src/editor/gestures/eraser-intersection";
import { visibleElementPrimitiveSteps } from "../../../../src/editor/selection/element-selection-geometry";
import {
  moveSelection,
  rotateSelection,
  scaleElement,
} from "../../../../src/editor/selection/transforms";
import type { StrokeElementV1 } from "../../../../src/domain/schema/public";

function positionedStroke(): StrokeElementV1 {
  return { ...stroke(), offset: { x: 100, y: 50 }, pivot: { x: 210, y: 160 }, rotation: 37 };
}

describe("positioned stroke interactions", () => {
  it.each(["pressure", "pen", "highlighter"])("selects and erases positioned %s ink", (tool) => {
    const source = positionedStroke();
    source.tool = tool === "highlighter" ? "highlighter" : "pen";
    source.style = { ...source.style, pressureEnabled: tool === "pressure" };
    const first = strokeWorldPoint(source, { x: 100, y: 100 });
    const second = strokeWorldPoint(source, { x: 120, y: 120 });
    const primitives = [...visibleElementPrimitiveSteps(source)].filter(
      (primitive) => typeof primitive === "object",
    );
    expect(primitives[0]).toMatchObject(
      tool === "pressure"
        ? {
            kind: "pressure-capsule",
            capsule: { start: { center: first }, end: { center: second } },
          }
        : { kind: "capsule", start: first, end: second },
    );
    expect(elementContainsPoint(source, first, 0)).toBe(true);
    expect(elementContainsPoint(source, { x: 0, y: 0 }, 0)).toBe(false);
    expect(createSweptCapsuleCheck(first, second, 1, source).advance(100).result).toBe(true);
    expect(
      createSweptCapsuleCheck({ x: 0, y: 0 }, { x: 1, y: 1 }, 1, source).advance(100).result,
    ).toBe(false);
  });

  it("flattens a positioned shape only when resizing its samples", () => {
    const source = positionedStroke();
    const scaled = scaleElement(source, { x: 0, y: 0 }, { x: 2, y: 3 });
    expect(scaled).toMatchObject({
      points: [400, 450, 0.5, 440, 510, 1],
      pivot: { x: 420, y: 480 },
    });
    expect(scaled).not.toHaveProperty("offset");
    expect(source.points).toEqual(stroke().points);
  });

  it("moves and rotates around selection centers while keeping sample identity", () => {
    const source = positionedStroke();
    const moved = moveSelection([source], { x: 10, y: -20 })[0] as StrokeElementV1;
    expect(moved.points).toBe(source.points);
    expect(moved.offset).toEqual({ x: 110, y: 30 });
    const rotated = rotateSelection([source], source.pivot, 90)[0] as StrokeElementV1;
    expect(rotated.points).toBe(source.points);
    expect(rotated.offset).toEqual(source.offset);
    expect(rotated.rotation).toBe(127);
    expect(transformedStrokeCenters(rotated)).toHaveLength(2);
  });
});
