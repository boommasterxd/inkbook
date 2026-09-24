import { describe, expect, it } from "vitest";
import type { RawStrokeSample } from "../../../../src/domain/geometry/public";
import type { StrokeStyleV1 } from "../../../../src/domain/schema/public";
import { LiveStrokeBuilder } from "../../../../src/editor/tools/live-stroke";

function draw(
  samples: readonly RawStrokeSample[],
  source: "pen" | "simulated",
  zoom = 1,
  width: StrokeStyleV1["width"] = 8,
) {
  const builder = new LiveStrokeBuilder({
    input: { pressureSource: source, zoom },
    style: {
      color: { type: "theme-text" },
      width,
      opacity: 1,
      pressureEnabled: true,
      smoothing: 0.5,
    },
  });
  builder.appendBatch(samples);
  return builder.finish().points.filter((_, index) => index % 3 === 2);
}

function movement(speed: number, spacing = 1, zoom = 1): RawStrokeSample[] {
  return Array.from({ length: 40 / spacing + 1 }, (_, index) => ({
    x: (index * spacing) / zoom,
    y: 0,
    time: (index * spacing) / speed,
    pressure: index === 0 ? 0.2 : 0.8,
  }));
}

describe("live stroke pressure response", () => {
  it("suppresses slow pen jitter and preserves intentional pressure changes", () => {
    const jitter = movement(0.05, 0.5).map((sample, index) => ({
      ...sample,
      pressure: index === 0 ? 0.5 : index % 2 === 0 ? 0.65 : 0.35,
    }));
    const pressures = draw(jitter, "pen");
    expect(Math.max(...pressures) - Math.min(...pressures)).toBeLessThan(0.06);
    const rising = draw(movement(0.05), "pen");
    expect(rising[1]).toBeGreaterThan(0.2);
    expect(rising[1]).toBeLessThan(0.5);
    expect(rising[9]).toBeGreaterThan(0.77);
    expect(rising.slice(-1)[0]).toBe(0.8);
  });

  it("keeps a broad nib smooth under rapid pressure jitter while retaining deliberate modulation", () => {
    const samples = Array.from({ length: 161 }, (_, index) => ({
      x: index * 1.8,
      y: 0,
      pressure: 0.6 + 0.18 * Math.sin(index * 1.7),
      time: index * 36,
    }));
    const pressures = draw(samples, "pen", 1, 22).slice(20);
    // Less than half a screen pixel of radius variation avoids the visibly scalloped edge.
    const radiusRange = (22 * 0.65 * (Math.max(...pressures) - Math.min(...pressures))) / 2;
    expect(radiusRange).toBeLessThan(0.5);
    const deliberate = samples.map((sample, index) => ({
      ...sample,
      pressure: index < 80 ? 0.2 : 0.8,
    }));
    const rising = draw(deliberate, "pen", 1, 22);
    expect(rising[79]).toBe(0.2);
    expect(rising[93]).toBeGreaterThan(0.77);
    expect(rising[160]).toBe(0.8);
  });

  it("makes slow mouse movement visibly thicker than fast movement", () => {
    const slow = draw(movement(0.1), "simulated").slice(-1)[0]!;
    const fast = draw(movement(1), "simulated").slice(-1)[0]!;
    expect(slow).toBeGreaterThan(0.9);
    expect(fast).toBeLessThan(0.15);
    expect((0.35 + 0.65 * slow) / (0.35 + 0.65 * fast)).toBeGreaterThan(2);
  });

  it.each(["pen", "simulated"] as const)(
    "keeps %s pressure independent of sample cadence and zoom for equal screen movement",
    (source) => {
      const baseline = draw(movement(0.4), source);
      for (const spacing of [0.5, 2]) {
        const pressures = draw(movement(0.4, spacing), source);
        expect(pressures[4 / spacing]).toBe(baseline[4]);
        expect(pressures.slice(-1)[0]).toBe(baseline.slice(-1)[0]);
      }
      expect(draw(movement(0.4, 1, 2), source, 2, 4)).toEqual(baseline);
    },
  );

  it("does not inflate a stationary tip or let replacement events accumulate pressure", () => {
    const samples = [
      { x: 0, y: 0, pressure: 0.4, time: 0 },
      { x: 1, y: 0, pressure: 0.6, time: 10 },
    ];
    const repeated = Array.from({ length: 100 }, (_, index) => ({
      x: 1,
      y: 0,
      pressure: 1,
      time: 11 + index,
    }));
    expect(draw([...samples, ...repeated], "pen")).toEqual(
      draw([...samples, repeated.slice(-1)[0]!], "pen"),
    );
    const stationary = repeated.map((sample) => ({ ...sample, x: 0 }));
    expect(draw([samples[0]!, ...stationary], "pen")).toEqual([0.4, 0.4]);
  });

  it("bounds pen pressure and keeps simulated input finite for repeated timestamps", () => {
    const samples = [
      { x: 0, y: 0, pressure: -5, time: 0 },
      { x: 20, y: 0, pressure: 5, time: 0 },
    ];
    expect(draw(samples, "pen")).toEqual([0, 0.9992]);
    const simulated = draw(samples, "simulated");
    expect(simulated.every((pressure) => pressure >= 0 && pressure <= 1)).toBe(true);
  });
});
