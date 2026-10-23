import { primitiveTouchesArea } from "../../../fixtures/editor/selection-query";
import { describe, expect, it } from "vitest";

import type { PointV1 } from "../../../../src/domain/schema/public";
import {
  createLassoSelectionArea,
  createRectangleSelectionArea,
} from "../../../../src/editor/selection/query/selection-area";
import {
  primitiveEnclosedByAreaSteps,
  type VisibleSelectionPrimitive,
} from "../../../../src/editor/selection/query/selection-area-primitives";

const capsule: VisibleSelectionPrimitive = {
  kind: "pressure-capsule",
  capsule: {
    start: { center: { x: 0, y: 0 }, radius: 1 },
    end: { center: { x: 10, y: 0 }, radius: 1 },
  },
};
const outer = [
  { x: -5, y: -5 },
  { x: 15, y: -5 },
  { x: 15, y: 5 },
  { x: -5, y: 5 },
  { x: -5, y: -5 },
];

function enclosed(points: readonly PointV1[]): boolean {
  const steps = primitiveEnclosedByAreaSteps(createLassoSelectionArea(points), capsule);
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
}

describe("exact pressure capsule area selection", () => {
  it("selects ink between the former sampled endpoint-arc vertices", () => {
    const angle = Math.PI / 48;
    const x = 10 + Math.cos(angle) * 0.9999;
    const y = Math.sin(angle) * 0.9999;
    expect(
      primitiveTouchesArea(
        createRectangleSelectionArea(
          { x: x - 0.00001, y: y - 0.00001 },
          { x: x + 0.00001, y: y + 0.00001 },
        ),
        capsule,
      ),
    ).toBe(true);
  });

  it("accepts exact endpoint tangency and rejects nearby empty regions", () => {
    expect(
      primitiveTouchesArea(
        createRectangleSelectionArea({ x: 11, y: -0.01 }, { x: 11.01, y: 0.01 }),
        capsule,
      ),
    ).toBe(true);
    expect(
      primitiveTouchesArea(
        createRectangleSelectionArea({ x: 11.001, y: -0.01 }, { x: 11.01, y: 0.01 }),
        capsule,
      ),
    ).toBe(false);
    expect(enclosed(outer)).toBe(true);
    expect(
      enclosed([
        { x: -5, y: -5 },
        { x: 15, y: -5 },
        { x: 15, y: 0.99 },
        { x: -5, y: 0.99 },
      ]),
    ).toBe(false);
  });

  it("rejects an even-odd hole wholly inside the capsule", () => {
    expect(
      enclosed([
        ...outer,
        { x: 4, y: -0.3 },
        { x: 6, y: -0.3 },
        { x: 6, y: 0.3 },
        { x: 4, y: 0.3 },
        { x: 4, y: -0.3 },
        outer[0]!,
      ]),
    ).toBe(false);
  });

  it("ignores retraced connectors but does not fill an exterior retraced spike", () => {
    expect(enclosed([...outer, { x: 5, y: 0 }, outer[0]!])).toBe(true);
    expect(
      enclosed([
        { x: -5, y: -5 },
        { x: 15, y: -5 },
        { x: 15, y: -3 },
        { x: -5, y: -3 },
        { x: -5, y: -5 },
        { x: 0, y: 0 },
        { x: -5, y: -5 },
      ]),
    ).toBe(false);
  });
});
