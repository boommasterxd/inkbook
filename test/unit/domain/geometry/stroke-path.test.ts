import { buildPressureOutline } from "../../../../src/domain/geometry/pressure-outline";
import type { StrokeElementV1 } from "../../../../src/domain/schema/public";
import { describe, expect, it } from "vitest";

import { rotatePointClockwise, smoothStrokeCenters } from "../../../../src/domain/geometry/public";
import { prepareExpectedStrokeSamples as prepareStrokeSamples } from "../../../fixtures/editor/stroke-sample-reference";
import { buildStrokePathParts, buildCenterline } from "../../../../src/domain/geometry/stroke-path";
import { strokeStyle } from "./fixtures";

function stroke(overrides: Partial<StrokeElementV1> = {}): StrokeElementV1 {
  return {
    id: "00000000-0000-4000-8000-000000000005",
    createdAt: 0,
    kind: "stroke",
    tool: "pen",
    points: [0, 0, 0.5, 10, 0, 0.5],
    rotation: 0,
    pivot: { x: 5, y: 0 },
    style: strokeStyle,
    ...overrides,
  };
}

describe("deterministic stroke construction", () => {
  it("retains endpoints, merges close interior tips, and simulates pressure", () => {
    const points = prepareStrokeSamples(
      [
        { x: 0, y: 0, pressure: 0, time: 0 },
        { x: 0.1, y: 0, pressure: 0, time: 1 },
        { x: 0.2, y: 0, pressure: 0, time: 2 },
        { x: 10, y: 0, pressure: 0, time: 12 },
      ],
      { pressureSource: "simulated", zoom: 1 },
    );
    expect(points).toHaveLength(9);
    expect(points.slice(0, 3)).toEqual([0, 0, 0.5]);
    expect(points.slice(-3, -1)).toEqual([10, 0]);
    expect(points[5]).toBeGreaterThanOrEqual(0.25);
  });

  it("clamps finite pen pressure and rejects invalid samples", () => {
    const points = prepareStrokeSamples(
      [
        { x: 0, y: 0, pressure: -1, time: 0 },
        { x: 1, y: 0, pressure: 2, time: 1 },
      ],
      { pressureSource: "pen", zoom: 1 },
    );
    expect(points).toEqual([0, 0, 0, 1, 0, 0.3003]);
    expect(() =>
      prepareStrokeSamples([{ x: 0, y: 0, pressure: Number.NaN, time: 0 }], {
        pressureSource: "pen",
        zoom: 1,
      }),
    ).toThrow(RangeError);
    expect(() => prepareStrokeSamples([], { pressureSource: "pen", zoom: 1 })).toThrow(RangeError);
    expect(() =>
      prepareStrokeSamples([{ x: 0, y: 0, pressure: 1, time: 0 }], {
        pressureSource: "pen",
        zoom: 0,
      }),
    ).toThrow(RangeError);
  });

  it("smooths only interior centers without changing raw samples", () => {
    const raw = [0, 0, 0.5, 10, 20, 0.7, 20, 0, 0.5];
    expect(smoothStrokeCenters(raw)).toEqual([
      { x: 0, y: 0, pressure: 0.5 },
      { x: 10, y: 10, pressure: 0.7 },
      { x: 20, y: 0, pressure: 0.5 },
    ]);
    expect(raw[4]).toBe(20);
    expect(() => smoothStrokeCenters([0, 0])).toThrow(RangeError);
  });

  it("uses midpoint quadratic segments for constant-width paths", () => {
    expect(buildCenterline([{ x: 1, y: 2 }])).toBe("M1 2L1 2");
    expect(
      buildCenterline([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
    ).toBe("M0 0L10 0");
    expect(
      buildCenterline([
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 20, y: 0 },
      ]),
    ).toBe("M0 0L5 5Q10 10 15 5L20 0");
    expect(() => buildCenterline([])).toThrow(RangeError);
  });
});

describe("stroke path fast-path parity", () => {
  it.each([
    ["single center", [1.125, -2.25, 0.5], { x: 0, y: 0 }],
    ["two translated centers", [101, 202, 0.2, 105, 208, 0.8], { x: 100, y: 200 }],
    ["smoothed centers", [0, 0, 0, 10, 20, 0.5, 20, 0, 1], { x: 10, y: 10 }],
    ["repeated centers", [4, 6, 0.5, 4, 6, 0.5, 4, 6, 0.5], { x: 4, y: 6 }],
    [
      "canonical decimal centers",
      [-1.234, 2.345, 0.1, 3.456, -4.567, 0.9, 8.765, 9.876, 0.4, 12.345, 14.567, 1],
      { x: 5.5, y: 6.5 },
    ],
  ] as const)("matches the generic centerline for %s", (_label, points, pivot) => {
    const candidate = buildStrokePathParts(stroke({ points: [...points], pivot }));
    const reference = buildCenterline(smoothStrokeCenters(points));

    expect(candidate).toEqual([{ d: reference, paint: "stroke" }]);
  });

  it.each([0.001, 45, 90, 359.999])(
    "preserves generic centerline parity for %s degree rotation",
    (rotation) => {
      const value = stroke({
        pivot: { x: 7.5, y: -3.25 },
        points: [-2, 4, 0.1, 5, 8, 0.5, 13, -6, 1, 21, 2, 0.7],
        rotation,
      });
      const centers = smoothStrokeCenters(value.points).map((center) =>
        rotatePointClockwise(center, value.pivot, rotation),
      );

      expect(buildStrokePathParts(value)).toEqual([
        { d: buildCenterline(centers), paint: "stroke" },
      ]);
    },
  );

  it.each([
    ["single center", [1, 2, 0.5]],
    ["two centers", [-5, 4, 0, 7, -8, 1]],
    ["varying pressure", [0, 0, 0, 10, 20, 0.25, 20, 0, 0.75, 30, 10, 1]],
    ["opposing segments", [0, 0, 0.5, 10, 10, 0.6, 0, 0, 0.7]],
    ["repeated centers", [4, 6, 0.5, 4, 6, 0.5, 8, 10, 0.75]],
  ] as const)("matches the canonical pressure outline for %s", (_label, points) => {
    const style = { ...strokeStyle, pressureEnabled: true, width: 8 as const };
    const candidate = buildStrokePathParts(stroke({ points: [...points], style }));
    const reference = buildPressureOutline(smoothStrokeCenters(points), style.width);

    expect(candidate).toEqual(reference);
  });

  it("keeps repeated-center pressure paths canonical and stable", () => {
    const repeated = stroke({
      points: [0, 0, 0.5, 0, 0, 0.5, 10, 10, 0.75, 10, 10, 0.75, 20, 20, 1],
      style: { ...strokeStyle, pressureEnabled: true },
    });

    const first = buildStrokePathParts(repeated);
    const second = buildStrokePathParts(repeated);

    expect(first).toEqual(second);
    expect(first.map((part) => part.d).join("")).not.toContain("NaN");
    expect(first.map((part) => part.d).join("")).not.toContain("Infinity");
  });

  it("builds identical paths from identical canonical samples and bakes rotation", () => {
    const pressureStroke = stroke({
      points: [0, 0, 0.5, 10, 10, 0.75, 20, 0, 1],
      rotation: 90,
      pivot: { x: 10, y: 0 },
      style: { ...strokeStyle, pressureEnabled: true },
    });
    const first = buildStrokePathParts(pressureStroke);
    const second = buildStrokePathParts(pressureStroke);
    expect(first).toEqual(second);
    expect(first.every((part) => part.paint === "fill")).toBe(true);
    expect(first.map((part) => part.d).join("")).not.toContain("transform");
    expect(buildStrokePathParts(stroke())[0]!.paint).toBe("stroke");
  });
});
