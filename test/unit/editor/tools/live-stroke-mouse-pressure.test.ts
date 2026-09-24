import { describe, expect, it } from "vitest";
import type { RawStrokeSample } from "../../../../src/domain/geometry/public";
import { LiveStrokeBuilder } from "../../../../src/editor/tools/live-stroke";

function draw(samples: readonly RawStrokeSample[], zoom: number, batchSize = samples.length) {
  const builder = new LiveStrokeBuilder({
    input: { pressureSource: "simulated", zoom },
    style: {
      color: { type: "theme-text" },
      width: 22,
      opacity: 1,
      pressureEnabled: true,
      smoothing: 0.5,
    },
  });
  for (let index = 0; index < samples.length; index += batchSize) {
    builder.appendBatch(samples.slice(index, index + batchSize));
  }
  return builder.finish().points;
}

function movement(intervals: readonly number[], zoom: number): RawStrokeSample[] {
  let time = 0;
  return Array.from({ length: 1001 }, (_, index) => {
    if (index > 0) time += intervals[(index - 1) % intervals.length]!;
    return { x: (index * 2) / zoom, y: 0, time, pressure: 0.5 };
  });
}

function pressures(points: readonly number[]) {
  return points.filter((_, index) => index % 3 === 2);
}

function mean(values: readonly number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

describe("simulated pressure stability", () => {
  it.each([1, 4.64, 8])("smooths noisy mouse timing with a broad nib at zoom %s", (zoom) => {
    const ideal = pressures(draw(movement([8], zoom), zoom)).slice(500);
    for (const intervals of [
      [1, 15],
      [1, 1, 1, 1, 15, 15, 15, 15],
    ]) {
      const actual = pressures(draw(movement(intervals, zoom), zoom)).slice(500);
      const radiusRange = (Math.max(...actual) - Math.min(...actual)) * 22 * zoom * 0.65 * 0.5;
      expect(radiusRange).toBeLessThan(0.6);
      expect(Math.abs(mean(actual) - mean(ideal))).toBeLessThan(0.04);
    }
  });

  it("retains deliberate slow and fast width changes", () => {
    const zoom = 4.64;
    let time = 0;
    const samples = movement([8], zoom).map((sample, index) => {
      if (index > 0) time += index < 350 || index >= 700 ? 20 : 2;
      return { ...sample, time };
    });
    const result = pressures(draw(samples, zoom));
    const slow = result[349]!;
    const fast = result[699]!;
    expect(slow).toBeGreaterThan(0.9);
    expect(fast).toBeLessThan(0.15);
    expect((0.35 + 0.65 * slow) / (0.35 + 0.65 * fast)).toBeGreaterThan(2);
    expect(result[400]).toBeLessThan(0.3);
    expect(result[799]).toBeGreaterThan(0.9);
  });

  it("handles rounded mouse coordinates without turning quantization into width jumps", () => {
    const zoom = 4.64;
    const samples = Array.from({ length: 1601 }, (_, index) => ({
      x: Math.round(index * 0.35) / zoom,
      y: 0,
      time: index * 2,
      pressure: 0.5,
    }));
    const result = pressures(draw(samples, zoom)).slice(300);
    const radiusRange = (Math.max(...result) - Math.min(...result)) * 22 * zoom * 0.65 * 0.5;
    expect(radiusRange).toBeLessThan(0.6);
    expect(Math.abs(mean(result) - 0.8)).toBeLessThan(0.04);
  });

  it("produces identical stored points for individual and coalesced samples", () => {
    const samples = movement([1, 1, 15, 15], 4.64);
    const baseline = draw(samples, 4.64);
    expect(draw(samples, 4.64, 1)).toEqual(baseline);
    expect(draw(samples, 4.64, 17)).toEqual(baseline);
  });

  it("does not inflate a stationary mouse tip when duplicate events arrive", () => {
    const samples = movement([2], 4.64).slice(0, 30);
    const last = samples[samples.length - 1]!;
    const repeated = Array.from({ length: 100 }, (_, index) => ({
      ...last,
      time: last.time + index * 10,
    }));
    expect(draw([...samples, ...repeated], 4.64)).toEqual(draw(samples, 4.64));
  });
});
