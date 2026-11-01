import { describe, expect, it } from "vitest";
import { pressureRadius } from "../../../../../src/domain/geometry/pressure/pressure-radius";
import { smoothStrokeCenters } from "../../../../../src/domain/geometry/stroke-path";
import { simplifyStrokeCenters } from "../../../../../src/domain/geometry/stroke-simplification";
import type { StrokeElementV1 } from "../../../../../src/domain/schema/types";
import { convertObsidianInk } from "../../../../../src/persistence/import/obsidian-ink/convert";
import { remapSourcePressurePointsSteps } from "../../../../../src/persistence/import/obsidian-ink/source-pressure";
import type {
  SourceStrokeCurve,
  SourceStrokeCurvePoint,
} from "../../../../../src/persistence/import/obsidian-ink/source-stroke-curve";
import { completeSteps } from "../../../../../src/persistence/import/obsidian-ink/source-values";
import { sampleSourceStrokeCurveSteps } from "../../../../../src/persistence/import/obsidian-ink/stroke-geometry";
import { roundTripInkbookSnapshotForTest } from "../../../../fixtures/persistence/parse-document";
import { canvasSnapshot, canvasStroke, canvasStyle, inkSvg } from "./fixtures";

const options = () => ({
  timestamp: 100,
  signal: new AbortController().signal,
  checkpoint: () => undefined,
});
const style = { ...canvasStyle, thinning: 0.6 };

function sourceDiameter(pressure: number, thinning = 0.6, pen = true): number {
  const response = 0.5 + thinning * (pressure - 0.5);
  return 8 * (pen ? 0.65 * response + 0.35 * Math.sin((Math.PI * response) / 2) : response);
}

function centers(stroke: StrokeElementV1) {
  return simplifyStrokeCenters(
    smoothStrokeCenters(stroke.points),
    stroke.style.width,
    stroke.style.pressureEnabled,
  );
}

function linePoints(start: number, end: number): SourceStrokeCurvePoint[] {
  return [
    { x: 0, y: 0, pressure: start },
    { x: 200, y: 0, pressure: end },
  ];
}

function line(points: readonly SourceStrokeCurvePoint[]): SourceStrokeCurve {
  return {
    start: points[0]!,
    segments: [{ kind: "line", end: points[1]! }],
    approximate: true,
  };
}

async function fittedCenters(curve: SourceStrokeCurve, width: number) {
  const points = await completeSteps(sampleSourceStrokeCurveSteps(curve), options());
  return simplifyStrokeCenters(smoothStrokeCenters(points), width, true);
}

describe("Source pressure width conversion", () => {
  it("chooses a wider native preset to preserve the Official pen's physical pressure range", async () => {
    const imported = await convertObsidianInk(
      inkSvg(canvasSnapshot({ strokes: [{ ...canvasStroke(), style }] })),
      options(),
    );
    const stroke = imported.snapshot.elements[0];
    if (stroke?.kind !== "stroke") throw new Error("Expected imported handwriting.");
    expect(stroke.style).toMatchObject({ width: 8, pressureEnabled: true });
    const rendered = centers(stroke);
    expect(
      Math.abs(2 * pressureRadius(rendered[0]!.pressure, 8) - sourceDiameter(0.25)),
    ).toBeLessThanOrEqual(0.002);
    expect(
      Math.abs(
        2 * pressureRadius(rendered[rendered.length - 1]!.pressure, 8) - sourceDiameter(0.75),
      ),
    ).toBeLessThanOrEqual(0.002);
    expect(imported.warnings.some((warning) => warning.includes("clipped"))).toBe(false);
    const loaded = await roundTripInkbookSnapshotForTest(imported.snapshot);
    expect(loaded).toEqual(imported.snapshot);
    const reloaded = loaded.elements[0];
    if (reloaded?.kind !== "stroke") throw new Error("Expected reloaded handwriting.");
    expect(centers(reloaded)).toEqual(rendered);
  });

  it("uses explicit mouse input and preserves reversed pressure from negative thinning", async () => {
    for (const profile of [
      { inputKind: "mouse", thinning: 0.6, simulatePressure: false },
      { inputKind: "pen", thinning: -0.6, simulatePressure: true },
      { inputKind: undefined, thinning: 0.6, simulatePressure: undefined },
    ]) {
      const mapped = await completeSteps(
        remapSourcePressurePointsSteps(linePoints(0.25, 0.75), { ...style, ...profile }, new Set()),
        options(),
      );
      const width = mapped.width ?? 4;
      const rendered = await fittedCenters(line(mapped.points), width);
      // Legacy styles with neither field use the source renderer's pen easing.
      const first = sourceDiameter(0.25, profile.thinning, profile.inputKind !== "mouse");
      const last = sourceDiameter(0.75, profile.thinning, profile.inputKind !== "mouse");
      for (const center of rendered) {
        const expected = first + ((last - first) * center.x) / 200;
        expect(Math.abs(2 * pressureRadius(center.pressure, width) - expected)).toBeLessThanOrEqual(
          0.01,
        );
      }
      expect(rendered[rendered.length - 1]!.pressure > rendered[0]!.pressure).toBe(
        profile.thinning > 0,
      );
    }
  });
});

describe("Source pressure curve and range constraints", () => {
  it("retains a quadratic width peak after native centerline simplification", async () => {
    const vertices = [
      { x: 0, y: 0, pressure: 0.25 },
      { x: 100, y: 0, pressure: 0.75 },
      { x: 200, y: 0, pressure: 0.25 },
    ];
    const mapped = await completeSteps(
      remapSourcePressurePointsSteps(vertices, style, new Set()),
      options(),
    );
    const curve: SourceStrokeCurve = {
      start: mapped.points[0]!,
      segments: [
        {
          kind: "quadratic",
          control: mapped.points[1]!,
          end: mapped.points[2]!,
        },
      ],
      approximate: true,
    };
    const width = mapped.width ?? 4;
    const rendered = await fittedCenters(curve, width);
    const peak = rendered.reduce((highest, point) =>
      point.pressure > highest.pressure ? point : highest,
    );
    expect(Math.abs(peak.x - 100)).toBeLessThanOrEqual(0.25);
    const expected = (sourceDiameter(0.25) + sourceDiameter(0.75)) / 2;
    // Native simplification permits a .125 radius displacement on pressure strokes.
    expect(Math.abs(2 * pressureRadius(peak.pressure, width) - expected)).toBeLessThanOrEqual(0.25);
    expect(peak.pressure).toBeGreaterThan(rendered[0]!.pressure);
  });

  it("reports clipping when the source's zero-to-full pressure range fits no native preset", async () => {
    const warnings = new Set<string>();
    const mapped = await completeSteps(
      remapSourcePressurePointsSteps(linePoints(0, 1), style, warnings),
      options(),
    );
    const width = mapped.width ?? 4;
    const rendered = await fittedCenters(line(mapped.points), width);
    expect([...warnings]).toContain(
      "Source pressure widths exceeded Inkbook's native pen range and were clipped.",
    );
    expect(rendered.every((point) => point.pressure >= 0 && point.pressure <= 1)).toBe(true);
    expect(rendered[0]!.pressure === 0 || rendered[rendered.length - 1]!.pressure === 1).toBe(true);
    expect(sourceDiameter(0)).toBeLessThan(width * 0.35);
    expect(2 * pressureRadius(rendered[rendered.length - 1]!.pressure, width)).toBeCloseTo(
      sourceDiameter(1),
      2,
    );
  });

  it("retains constant-width and highlighter profiles without enabling native pressure", async () => {
    for (const constant of [
      { ...style, thinning: 0 },
      { ...style, brush: "highlighter" },
    ]) {
      const points = linePoints(0, 1);
      const result = await completeSteps(
        remapSourcePressurePointsSteps(points, constant, new Set()),
        options(),
      );
      expect(result.points).toBe(points);
      expect(result.width).toBeUndefined();
    }
  });
});
