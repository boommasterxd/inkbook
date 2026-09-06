import { describe, expect, it } from "vitest";

import {
  buildCenterline,
  pressureWidthFactor,
  smoothStrokeCenters,
} from "../../../../src/domain/geometry/stroke-path";
import { rotatePointClockwise } from "../../../../src/domain/geometry/primitives";
import type { StrokeElementV1 } from "../../../../src/domain/schema/public";
import { buildPressurePreviewPathParts } from "../../../../src/rendering/scene/pressure-preview-path";

describe("pressure scale preview paths", () => {
  it("retains the exact width and degenerate geometry of a constant-pressure point", () => {
    const stroke = pressureStroke([10, 20, 0.42], 8);

    expect(buildPressurePreviewPathParts(stroke)).toEqual([
      {
        d: "M10 20L10 20",
        paint: "stroke",
        strokeWidth: 8 * pressureWidthFactor(0.42),
      },
    ]);
  });

  it("matches the canonical smoothed centerline after rotation at constant pressure", () => {
    const stroke = {
      ...pressureStroke([0, 0, 0.37, 20, 30, 0.37, 50, 10, 0.37], 14),
      pivot: { x: 10, y: 5 },
      rotation: 90,
    };
    const centers = smoothStrokeCenters(stroke.points).map((center) =>
      rotatePointClockwise(center, stroke.pivot, stroke.rotation),
    );

    const [part] = buildPressurePreviewPathParts(stroke);

    expect(part).toEqual({
      d: buildCenterline(centers),
      paint: "stroke",
      strokeWidth: 14 * pressureWidthFactor(0.37),
    });
  });

  it("uses at most sixteen deterministic nearest-width bands", () => {
    const stroke = pressureStroke([0, 0, 0, 100, 0, 1], 22);

    const first = buildPressurePreviewPathParts(stroke);
    const second = buildPressurePreviewPathParts(stroke);

    expect(first).toEqual(second);
    expect(first).toHaveLength(16);
    expect(first.map(({ strokeWidth }) => strokeWidth)).toEqual(
      Array.from({ length: 16 }, (_, band) => 22 * pressureWidthFactor(band / 15)),
    );
    expect((first[1]!.strokeWidth - first[0]!.strokeWidth) / 2).toBeCloseTo((22 * 0.65) / 30);
    expect(first.every(({ paint }) => paint === "stroke")).toBe(true);
  });
});

describe("pressure scale preview segmentation", () => {
  it("splits sharp pressure changes and preserves a short thin run", () => {
    const stroke = pressureStroke([0, 0, 1, 100, 40, 1, 101, 40, 0, 102, 40, 1, 200, 0, 1], 14);

    const parts = buildPressurePreviewPathParts(stroke);
    const thinnest = parts[0]!;
    const thickest = parts[parts.length - 1]!;

    expect(parts).toHaveLength(9);
    expect(thinnest.strokeWidth).toBe(14 * pressureWidthFactor(4 / 15));
    expect(thinnest.d).not.toBe("");
    expect(thickest.d.match(/M/g) ?? []).toHaveLength(2);
    expect(totalDrawingCommands(parts)).toBeGreaterThan(5);
  });

  it("keeps long uniform strokes in one complete path", () => {
    const samples = Array.from({ length: 4_096 }, (_, index) => [index, index % 7, 0.5]).flat();
    const stroke = pressureStroke(samples, 4);

    const [part] = buildPressurePreviewPathParts(stroke);

    expect(part?.d).toBe(buildCenterline(smoothStrokeCenters(stroke.points)));
    expect(part?.d.match(/Q/g) ?? []).toHaveLength(4_094);
  });

  it("preserves endpoints and loop segments across disjoint pressure runs", () => {
    const stroke = pressureStroke([0, 0, 0, 20, 20, 1, 0, 40, 0, -20, 20, 1, 0, 0, 0], 8);

    const parts = buildPressurePreviewPathParts(stroke);
    const combined = parts.map(({ d }) => d).join("");

    expect(parts).toHaveLength(12);
    expect(combined).toContain("M0 0");
    expect(combined).toContain("L0 0");
    expect(totalDrawingCommands(parts)).toBeGreaterThanOrEqual(5);
  });

  it("stays within sixteen paths at quantization boundaries", () => {
    const boundary = 0.5 / 15;
    const patterns = [
      [boundary - 1e-8, boundary + 1e-8],
      [0, 1, 0],
      [1, 0, 1, 0],
      [0.2, 0.8, 0.2, 0.8, 0.2],
    ];

    for (const pressures of patterns) {
      const points = pressures.flatMap((pressure, index) => [index * 10, index % 2, pressure]);
      const stroke = pressureStroke(points, 8);
      const parts = buildPressurePreviewPathParts(stroke);

      expect(buildPressurePreviewPathParts(stroke)).toEqual(parts);
      expect(parts.length).toBeLessThanOrEqual(16);
    }
  });

  it("clamps pressures before constant-width detection", () => {
    const stroke = pressureStroke([0, 0, -2, 10, 0, 0], 8);

    const parts = buildPressurePreviewPathParts(stroke);

    expect(parts).toHaveLength(1);
    expect(parts[0]?.strokeWidth).toBe(8 * pressureWidthFactor(0));
  });

  it("bounds adversarial pressure transitions without dropping centerline curves", () => {
    const points = Array.from({ length: 4_096 }, (_, index) => [index * 32, 0, index % 2]).flat();
    const parts = buildPressurePreviewPathParts(pressureStroke(points, 2));
    const commands = totalDrawingCommands(parts);

    expect(parts.length).toBeLessThanOrEqual(16);
    expect(commands).toBeGreaterThanOrEqual(4_096);
    expect(commands).toBeLessThanOrEqual(6_144);
    expect(parts.map(({ d }) => d).join("")).toContain("L131040 0");
    expect(parts[0]?.d).toContain("M0 0");
  });
});

function pressureStroke(
  points: number[],
  width: StrokeElementV1["style"]["width"],
): StrokeElementV1 {
  return {
    createdAt: 0,
    id: "10000000-0000-4000-8000-000000000001",
    kind: "stroke",
    pivot: { x: 0, y: 0 },
    points,
    rotation: 0,
    style: {
      color: { type: "theme-text" },
      opacity: 1,
      pressureEnabled: true,
      smoothing: 0.5,
      width,
    },
    tool: "pen",
  };
}

function totalDrawingCommands(parts: ReturnType<typeof buildPressurePreviewPathParts>): number {
  return parts.reduce((total, { d }) => total + (d.match(/[LQ]/g) ?? []).length, 0);
}
