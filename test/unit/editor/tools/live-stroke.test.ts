import { describe, expect, it, vi } from "vitest";

import * as pressureJoins from "../../../../src/domain/geometry/pressure/pressure-joins";
import * as pressureChains from "../../../../src/domain/geometry/pressure/pressure-chain-contour";
import { buildStrokePathParts } from "../../../../src/domain/geometry/stroke-path";
import type { RawStrokeSample } from "../../../../src/domain/geometry/public";
import { MAX_STROKE_POINTS, type StrokeStyleV1 } from "../../../../src/domain/schema/public";
import {
  LiveStrokeBuilder,
  type LiveStrokePreview,
} from "../../../../src/editor/tools/live-stroke";
import { prepareExpectedStrokeSamples as prepareStrokeSamples } from "../../../fixtures/editor/stroke-sample-reference";

const penStyle: StrokeStyleV1 = {
  color: { type: "theme-text" },
  width: 8,
  opacity: 1,
  pressureEnabled: true,
  smoothing: 0.5,
};

function sample(index: number): RawStrokeSample {
  return { x: index, y: Math.sin(index / 20) * 30, pressure: (index % 100) / 100, time: index };
}

function onePassPath(
  points: number[],
  style: StrokeStyleV1,
): ReturnType<typeof buildStrokePathParts> {
  return buildStrokePathParts({
    id: "00000000-0000-4000-8000-000000000000",
    createdAt: 0,
    kind: "stroke",
    tool: "pen",
    points,
    rotation: 0,
    pivot: { x: 0, y: 0 },
    style,
  });
}

function expectBoundedPreview(preview: LiveStrokePreview): void {
  expect(preview.tail.sampleCount).toBeLessThanOrEqual(130);
  for (const chunk of [...preview.finalizedChunks, preview.tail]) {
    expect(chunk.geometry).toHaveLength(1);
    expect(chunk.geometry[0]!.d).not.toMatch(/NaN|Infinity/);
  }
}

describe("live stroke builder", () => {
  it("matches one-pass retention, pressure, canonical samples, and geometry", () => {
    const raw = Array.from({ length: 80 }, (_, index) => sample(index));
    const input = { pressureSource: "simulated" as const, zoom: 1 };
    const builder = new LiveStrokeBuilder({ input, style: penStyle });
    for (const value of raw) builder.append(value);
    const commit = builder.finish();
    const expectedPoints = prepareStrokeSamples(raw, input);

    expect(commit.points).toEqual(expectedPoints);
    expect(commit.geometry).toEqual(onePassPath(expectedPoints, penStyle));
    expect(commit.instrumentation.commitBuilds).toBe(1);
  });

  it("never rebuilds more than the bounded tail or a finalized prefix twice", () => {
    const builder = new LiveStrokeBuilder({
      input: { pressureSource: "pen", zoom: 1 },
      style: penStyle,
    });
    let firstChunk: object | undefined;
    for (let index = 0; index < MAX_STROKE_POINTS; index += 1) {
      const preview = builder.append(sample(index));
      firstChunk ??= preview.finalizedChunks[0];
      if (firstChunk !== undefined) expect(preview.finalizedChunks[0]).toBe(firstChunk);
    }
    const commit = builder.finish();

    expect(commit.points).toHaveLength(MAX_STROKE_POINTS * 3);
    expect(commit.geometry).toEqual(onePassPath(commit.points, penStyle));
    expect(commit.instrumentation.maximumTailSamples).toBeLessThanOrEqual(131);
    expect(commit.instrumentation.maximumFinalizedChunkSamples).toBeLessThanOrEqual(131);
    expect(commit.instrumentation.retainedSamples).toBe(MAX_STROKE_POINTS);
    expect(commit.instrumentation.bufferGrowths).toBe(Math.log2(MAX_STROKE_POINTS / 16));
    expect(commit.instrumentation.tailBuilds).toBe(MAX_STROKE_POINTS);
    expect(firstChunk).toBeDefined();
  }, 20_000);

  it("retains every batched input sample while rebuilding the live tail once", () => {
    const builder = new LiveStrokeBuilder({
      input: { pressureSource: "pen", zoom: 1 },
      style: penStyle,
    });
    const samples = Array.from({ length: 48 }, (_, index) => sample(index));

    const preview = builder.appendBatch(samples);
    const commit = builder.finish();

    expect(commit.points).toEqual(
      prepareStrokeSamples(samples, { pressureSource: "pen", zoom: 1 }),
    );
    expect(commit.instrumentation.appendedInputSamples).toBe(samples.length);
    expect(commit.instrumentation.tailBuilds).toBe(1);
    expectBoundedPreview(preview);
  });
});

describe("live stroke preview geometry", () => {
  it("retains immutable windows and bounded smoothing context", () => {
    const builder = new LiveStrokeBuilder({
      input: { pressureSource: "pen", zoom: 1 },
      style: penStyle,
    });
    const preview = builder.appendBatch(Array.from({ length: 150 }, (_, index) => sample(index)));
    // Simplified windows accumulate until 64 derived capsules can be finalized.
    expect(preview.finalizedChunks).toHaveLength(0);
    expect(preview.tail.firstSample).toBe(64);
    expectBoundedPreview(preview);
    const commit = builder.finish();
    expect(commit.geometry).toEqual(onePassPath(commit.points, penStyle));
  });

  it.each([
    ["pen-pressure", penStyle, "pen"],
    ["simulated-pressure", penStyle, "simulated"],
    ["centerline", { ...penStyle, opacity: 0.4, pressureEnabled: false }, "pen"],
  ] as const)("matches one-pass %s geometry across every chunk boundary", (_, style, source) => {
    const raw = Array.from({ length: 321 }, (_, index) => ({
      pressure: ((index * 37) % 101) / 100,
      time: index * 2 + (index % 3),
      x: index * 1.25,
      y: Math.sin(index / 3) * 20 + (index % 9 === 0 ? 12 : 0),
    }));
    const input = { pressureSource: source, zoom: 1 };
    const builder = new LiveStrokeBuilder({ input, style });
    for (let index = 0; index < raw.length; index += 1) {
      const preview = builder.append(raw[index]!);
      expectBoundedPreview(preview);
    }
    const commit = builder.finish();
    expect(commit.geometry).toEqual(onePassPath(commit.points, style));
    expect(commit.instrumentation.maximumPendingPressurePieces).toBeLessThanOrEqual(64);
  });

  it("rebuilds only the exact tail when a close sample replaces its tip", () => {
    const input = { pressureSource: "pen" as const, zoom: 1 };
    const raw = Array.from({ length: 40 }, (_, index) => sample(index));
    const builder = new LiveStrokeBuilder({ input, style: penStyle });
    let preview = builder.append(raw[0]!);
    for (const value of raw.slice(1)) preview = builder.append(value);
    const prefix = preview.finalizedChunks.slice();
    const replacement = { ...sample(39), pressure: 0.9, time: 40, x: 39.1 };

    preview = builder.append(replacement);

    expect(preview.finalizedChunks).toEqual(prefix);
    expectBoundedPreview(preview);
    const commit = builder.finish();
    expect(commit.geometry).toEqual(onePassPath(commit.points, penStyle));
  });
});

describe("live stroke commit continuity", () => {
  it("retains single-point pen taps without deferring their canonical circle", () => {
    const builder = new LiveStrokeBuilder({
      input: { pressureSource: "pen", zoom: 1 },
      style: penStyle,
    });
    builder.append({ x: 10, y: 20, pressure: 0.5, time: 0 });
    const commit = builder.finish();
    expect(commit.deferGeometryPreparation).toBe(false);
    expect(commit.geometry).toEqual(onePassPath(commit.points, penStyle));
  });

  it("packs live window boundaries into the canonical continuous pressure contour", () => {
    const builder = new LiveStrokeBuilder({
      input: { pressureSource: "pen", zoom: 1 },
      style: penStyle,
    });
    const preview = builder.appendBatch(
      Array.from({ length: 400 }, (_, index) => ({
        x: index,
        y: Math.sin(index / 70) * 10,
        pressure: 0.5,
        time: index,
      })),
    );
    expect(preview.finalizedChunks).toHaveLength(0);
    const commit = builder.finish();
    expect(commit.geometry).toEqual(onePassPath(commit.points, penStyle));
    expect(commit.geometry[0]!.d.match(/M/g)).toHaveLength(1);
  });

  it("reuses finalized unions and materializes the bounded canonical tail only once", () => {
    const nibs = vi.spyOn(pressureJoins, "preparePressureNib");
    const chains = vi.spyOn(pressureChains, "pressureChainContour");
    try {
      const builder = new LiveStrokeBuilder({
        input: { pressureSource: "pen", zoom: 1 },
        style: penStyle,
      });
      for (let index = 0; index < 500; index += 1) builder.append(sample(index));
      const commit = builder.finish();
      expect(commit.deferGeometryPreparation).toBe(false);
      const preparedNibs = nibs.mock.calls.length;
      const preparedChains = chains.mock.calls.length;
      const geometry = commit.geometry;
      expect(nibs).toHaveBeenCalledTimes(preparedNibs);
      expect(chains).toHaveBeenCalledTimes(preparedChains);
      expect(commit.geometry).toBe(geometry);
      expect(nibs).toHaveBeenCalledTimes(preparedNibs);
      expect(chains).toHaveBeenCalledTimes(preparedChains);
      expect(geometry).toEqual(onePassPath(commit.points, penStyle));
    } finally {
      nibs.mockRestore();
      chains.mockRestore();
    }
  });

  it("retains exact one-pass pressure geometry for repeated smoothed centers", () => {
    const builder = new LiveStrokeBuilder({
      input: { pressureSource: "pen", zoom: 1 },
      style: penStyle,
    });
    for (let index = 0; index < 80; index += 1) {
      builder.append({
        pressure: 0.5,
        time: index,
        x: index % 2,
        y: 0,
      });
    }

    const commit = builder.finish();

    expect(commit.geometry).toEqual(onePassPath(commit.points, penStyle));
    expect(commit.instrumentation.commitBuilds).toBe(1);
  });
});

describe("live stroke window transitions", () => {
  it.each([63, 64, 65, 191, 192, 193])(
    "preserves reversals at sample %i across individual and batched input",
    (turn) => {
      const samples = Array.from({ length: 260 }, (_, index) => ({
        x: index <= turn ? index : 2 * turn - index,
        y: 0,
        pressure: index === turn ? 1 : 0.2,
        time: index,
      }));
      const individual = new LiveStrokeBuilder({
        input: { pressureSource: "pen", zoom: 1 },
        style: penStyle,
      });
      const batched = new LiveStrokeBuilder({
        input: { pressureSource: "pen", zoom: 1 },
        style: penStyle,
      });
      for (const value of samples) individual.append(value);
      batched.appendBatch(samples);
      const first = individual.finish();
      const second = batched.finish();
      expect(first.points).toEqual(second.points);
      expect(first.geometry).toEqual(second.geometry);
      expect(first.geometry).toEqual(onePassPath(first.points, penStyle));
    },
  );
});

describe("live stroke limits and lifecycle", () => {
  it("freezes the last accepted geometry when input exceeds the maximum", () => {
    const builder = new LiveStrokeBuilder({
      input: { pressureSource: "pen", zoom: 1 },
      style: penStyle,
    });

    let preview = builder.append(sample(0));
    for (let index = 1; index < MAX_STROKE_POINTS; index += 1)
      preview = builder.append(sample(index));
    const finalizedPrefix = preview.finalizedChunks.slice();
    preview = builder.append(sample(MAX_STROKE_POINTS));

    const commit = builder.finish();

    expect(commit.points).toHaveLength(MAX_STROKE_POINTS * 3);
    expect(commit.points[commit.points.length - 3]).toBe(MAX_STROKE_POINTS - 1);
    expect(builder.capacityExhausted).toBe(true);
    expect(commit.instrumentation.appendedInputSamples).toBe(MAX_STROKE_POINTS + 1);
    expect(commit.instrumentation.retainedSamples).toBe(MAX_STROKE_POINTS);
    expect(preview.finalizedChunks).toEqual(finalizedPrefix);
    expectBoundedPreview(preview);
  }, 20_000);

  it("replaces close mutable tips and enforces lifecycle and numeric limits", () => {
    const builder = new LiveStrokeBuilder({
      input: { pressureSource: "pen", zoom: 1 },
      style: penStyle,
    });
    builder.append({ x: 0, y: 0, pressure: 0.5, time: 0 });
    builder.append({ x: 1, y: 0, pressure: 0.5, time: 1 });
    builder.append({ x: 1.1, y: 0, pressure: 0.75, time: 2 });
    const commit = builder.finish();

    expect(commit.points).toEqual([0, 0, 0.5, 1.1, 0, 0.5812]);
    expect(commit.instrumentation.replacedTipSamples).toBe(1);
    expect(() => builder.append(sample(3))).toThrow(/finished/);
    expect(() => builder.finish()).toThrow(/only be finished once/);
    expect(
      () => new LiveStrokeBuilder({ input: { pressureSource: "pen", zoom: 0 }, style: penStyle }),
    ).toThrow(RangeError);
  });
});
