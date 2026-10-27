import { describe, expect, it } from "vitest";
import { denseWaveSamples } from "../../../fixtures/editor/stroke";
import { LiveStrokeBuilder } from "../../../../src/editor/tools/live-stroke";

function builder(pressureEnabled: boolean, source: "pen" | "simulated" = "pen", zoom = 1) {
  return new LiveStrokeBuilder({
    input: { pressureSource: source, zoom },
    style: {
      color: { type: "theme-text" },
      width: 8,
      opacity: 1,
      pressureEnabled,
      smoothing: 0.5,
    },
  });
}

const denseWave = denseWaveSamples();

describe("live stroke sample retention", () => {
  it.each([
    [true, "pen"],
    [false, "pen"],
    [true, "simulated"],
    [false, "simulated"],
  ] as const)("preserves dense handwriting with pressure=%s and source=%s", (pressure, source) => {
    const individual = builder(pressure, source);
    const coalesced = builder(pressure, source);
    for (const sample of denseWave) individual.append(sample);
    coalesced.appendBatch(denseWave);
    const commit = individual.finish();
    const batched = coalesced.finish();

    expect(batched.points).toEqual(commit.points);
    expect(batched.geometry).toEqual(commit.geometry);
    expect(commit.points.slice(0, 3)).toEqual([0, 0, source === "pen" ? 0.6 : 0.5]);
    expect(commit.points.slice(-3, -1)).toEqual([100, 0]);
    for (let lobe = 0; lobe < 6; lobe += 1) {
      const heights = commit.points.filter(
        (_, index) =>
          index % 3 === 1 &&
          commit.points[index - 1]! >= (100 * lobe) / 6 &&
          commit.points[index - 1]! < (100 * (lobe + 1)) / 6,
      );
      const peak = lobe % 2 === 0 ? Math.max(...heights) : -Math.min(...heights);
      expect(peak).toBeGreaterThan(19.9);
    }
    expect(commit.instrumentation.retainedSamples).toBeGreaterThan(300);
    expect(commit.instrumentation.maximumTailSamples).toBeLessThanOrEqual(131);
    expect(batched.instrumentation.tailBuilds).toBe(1);
  });

  it.each([0.5, 1, 2])("limits merged travel to half a screen pixel at zoom=%s", (zoom) => {
    const stroke = builder(false, "pen", zoom);
    // Reversal inside the merge radius still consumes travel; at exactly 0.5 px retain anew.
    const positions = [0, 1, 1.125, 1.25, 1.125, 1.25, 1.25, 1.75];
    for (const [time, x] of positions.entries()) {
      stroke.append({ x: x / zoom, y: 0, pressure: 0.5, time });
    }
    const commit = stroke.finish();

    expect(commit.points.filter((_, index) => index % 3 === 0)).toEqual(
      [0, 1.125, 1.25, 1.75].map((x) => Number((x / zoom).toFixed(3))),
    );
    expect(commit.instrumentation.replacedTipSamples).toBe(4);
  });

  it.each([
    ["pen", [0.2, 0.2, 0.3743, 0.4564, 0.5064, 0.6246]],
    ["simulated", [0.5, 0.5, 0.6127, 0.6546, 0.7432, 0.7954]],
  ] as const)(
    "preserves %s pressure history across replaced and stationary tips",
    (source, expected) => {
      const stroke = builder(false, source);
      const positions = [0, 0, 1, 1, 1.1, 1.2, 1.1, 1.2, 1.8, 1.8, 3, 4];
      const times = [0, 1, 2, 10, 11, 11, 12, 13, 14, 99, 99, 100];
      const pressures = [0.2, 0.3, 0.8, 1, 0.1, 0.9, 0.2, 0.7, 0.4, 0.8, 0.6, 0.9];
      for (const [index, x] of positions.entries()) {
        stroke.append({ x, y: 0, pressure: pressures[index]!, time: times[index]! });
      }
      const points = stroke.finish().points;
      expect(points.filter((_, index) => index % 3 === 0)).toEqual([0, 0, 1.2, 1.8, 3, 4]);
      // Fixed-width Pen still retains its genuine pressure history for later style changes.
      expect(points.filter((_, index) => index % 3 === 2)).toEqual(expected);
    },
  );
});
