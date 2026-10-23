import {
  serializePressureCapsules,
  serializePressureWindows,
} from "../../../../../src/domain/geometry/pressure/pressure-path-serialization";
import type { PressureOutlinePiece } from "../../../../../src/domain/geometry/pressure/pressure-outline-piece";
import { describe, expect, it } from "vitest";
import { roundCanonical } from "../../../../../src/domain/geometry/primitives";
import {
  buildPressureOutline,
  visitPressureOutline,
} from "../../../../../src/domain/geometry/pressure/pressure-outline";
import {
  decodeSvgPathCommands,
  sampleSvgPathContours,
} from "../../../../fixtures/domain/svg-path-fill";

function horizontalPath(start: number, end: number, y = 200000): string {
  return capsulePath([
    { x: start, y, pressure: 1 },
    { x: end, y, pressure: 1 },
  ]);
}

function capsulePath(centers: readonly { x: number; y: number; pressure: number }[]): string {
  const pieces: PressureOutlinePiece[] = [];
  visitPressureOutline(centers, 8, (piece) => {
    pieces.push(piece);
    return false;
  });
  return serializePressureCapsules(pieces);
}

describe("compact continuous outline serialization", () => {
  it("preserves the analytic straight contour with relative lines and circular caps", () => {
    const d = horizontalPath(100000, 100030);
    expect(d).toMatch(/[lh]/u);
    expect(d).toContain("a");
    const decoded = decodeSvgPathCommands(d);
    const endpoints = decoded
      .filter(({ values }) => values.length > 0)
      .map(({ values }) => values.slice(-2));
    expect(endpoints).toContainEqual([100030, 200004]);
    expect(endpoints).toContainEqual([100000, 199996]);
    const contour = sampleSvgPathContours(d).flat();
    expect(Math.min(...contour.map(({ x }) => x))).toBeCloseTo(99996, 3);
    expect(Math.max(...contour.map(({ x }) => x))).toBeCloseTo(100034, 3);
    expect(Math.min(...contour.map(({ y }) => y))).toBeCloseTo(199996, 3);
    expect(Math.max(...contour.map(({ y }) => y))).toBeCloseTo(200004, 3);
  });

  it("preserves canonical half-value rounding for dot centers and pressure radii", () => {
    const pressure = (3.3335 / 4 - 0.35) / 0.65;
    const center = { x: 123.4565, y: -123.4565, pressure };
    const radius = roundCanonical((8 * (0.35 + 0.65 * pressure)) / 2);
    const decoded = decodeSvgPathCommands(buildPressureOutline([center], 8)[0]!.d);
    expect(decoded[0]).toEqual({
      command: "M",
      values: [roundCanonical(center.x - radius), roundCanonical(center.y)],
    });
    expect(decoded.map(({ values }) => values.slice(-2))).toContainEqual([
      roundCanonical(center.x + radius),
      roundCanonical(center.y),
    ]);
    expect(decoded[decoded.length - 2]!.values.slice(-2)).toEqual(decoded[0]!.values);
  });

  it("uses absolute endpoints when shorter or when relative deltas exceed the coordinate limit", () => {
    expect(horizontalPath(0, 10, 0)).toContain("A4 4 0 0 0-4 0");
    const distant = horizontalPath(-900000, 900000, 0);
    expect(distant).not.toContain("h");
    expect(distant).toMatch(/[LH]-?900000/u);
    const endpoints = decodeSvgPathCommands(distant)
      .filter(({ values }) => values.length > 0)
      .map(({ values }) => values.slice(-2));
    expect(endpoints).toContainEqual([900000, 4]);
    expect(endpoints).toContainEqual([-900000, -4]);
  });

  it("preserves capsule endpoints when geometry translates and chooses a different contour start", () => {
    const centers = Array.from({ length: 65 }, (_, index) => ({
      x: index * 1.25,
      y: roundCanonical(10 * Math.sin(index / 8)),
      pressure: 0.5,
    }));
    const local = decodeSvgPathCommands(capsulePath(centers));
    const translated = decodeSvgPathCommands(
      capsulePath(centers.map((point) => ({ ...point, x: point.x + 100000, y: point.y + 200000 }))),
    );
    const endpoints = (commands: typeof local, x: number, y: number) =>
      commands
        .filter(({ values }) => values.length > 0)
        .map(({ values }) => [
          roundCanonical(values[values.length - 2]! - x),
          roundCanonical(values[values.length - 1]! - y),
        ])
        .sort((left, right) => left[0]! - right[0]! || left[1]! - right[1]!);
    expect(endpoints(translated, 100000, 200000)).toEqual(endpoints(local, 0, 0));
    expect(
      translated
        .filter(({ command }) => command === "A")
        .map(({ values }) => values.slice(0, 5))
        .sort(),
    ).toEqual(
      local
        .filter(({ command }) => command === "A")
        .map(({ values }) => values.slice(0, 5))
        .sort(),
    );
  });
});

describe("independent SVG path decoding", () => {
  it("independently resolves horizontal and vertical coordinates without losing the other axis", () => {
    expect(decodeSvgPathCommands("M10 20H30V40h-.125v.25Z")).toEqual([
      { command: "M", values: [10, 20] },
      { command: "L", values: [30, 20] },
      { command: "L", values: [30, 40] },
      { command: "L", values: [29.875, 40] },
      { command: "L", values: [29.875, 40.25] },
      { command: "Z", values: [] },
    ]);
  });

  it("independently decodes mixed commands, implicit lines and closepath origins", () => {
    expect(
      decodeSvgPathCommands(
        "M10 20l1.2.3-4 5q1 2 3 4a2 2 0 0 1-1-2Zm1 2L20 30Q1 2 3 4A2 2 0 0 1 5 6Z",
      ),
    ).toEqual([
      { command: "M", values: [10, 20] },
      { command: "L", values: [11.2, 20.3] },
      { command: "L", values: [7.2, 25.3] },
      { command: "Q", values: [8.2, 27.3, 10.2, 29.3] },
      { command: "A", values: [2, 2, 0, 0, 1, 9.2, 27.3] },
      { command: "Z", values: [] },
      { command: "M", values: [11, 22] },
      { command: "L", values: [20, 30] },
      { command: "Q", values: [1, 2, 3, 4] },
      { command: "A", values: [2, 2, 0, 0, 1, 5, 6] },
      { command: "Z", values: [] },
    ]);
  });
});

describe("compact relative fractions", () => {
  it("preserves all positive and negative thousandth displacements without leading zeros", () => {
    for (let thousandths = 1; thousandths < 1000; thousandths += 1) {
      const fraction = thousandths / 1000;
      const points = [
        { x: 100000, y: 200000 },
        { x: 100000 + fraction, y: 200001 },
        { x: 100000, y: 200002 },
        { x: 100000 + fraction, y: 200003 },
        { x: 100000, y: 200004 },
        { x: 100010, y: 200005 },
        { x: 100020, y: 200004 },
        { x: 100100, y: 200000 },
      ];
      const loop = points.map((start, index) => ({
        kind: "line" as const,
        start,
        end: points[(index + 1) % points.length]!,
      }));
      const d = serializePressureWindows([{ kind: "window", additions: [], loops: [loop] }]);
      const text = String(fraction).slice(1);
      expect(d).toContain(`l${text} 1`);
      expect(d).toContain(`-${text} 1`);
      const endpoints = decodeSvgPathCommands(d)
        .filter(({ values }) => values.length > 0)
        .map(({ values }) => values.slice(-2));
      for (const point of points)
        expect(endpoints).toContainEqual([roundCanonical(point.x), point.y]);
    }
  });
});
