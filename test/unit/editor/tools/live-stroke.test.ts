import { describe, expect, it } from "vitest";

import { buildStrokePath, smoothStrokeCenters } from "../../../../src/domain/geometry/public";
import type { RawStrokeSample } from "../../../../src/domain/geometry/public";
import type { StrokeStyleV1 } from "../../../../src/domain/schema/public";
import {
  buildCenterlineSlice,
  buildPressureOutlineSlice,
} from "../../../../src/domain/geometry/stroke-path-slice";
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

function onePassPath(points: number[], style: StrokeStyleV1): ReturnType<typeof buildStrokePath> {
  return buildStrokePath({
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

function expectExactPreview(
  preview: LiveStrokePreview,
  points: number[],
  style: StrokeStyleV1,
): void {
  const centers = smoothStrokeCenters(points);
  for (const chunk of preview.finalizedChunks) {
    const slice = {
      firstBoundary: chunk.firstSample === 0 ? null : chunk.firstSample - 1,
      lastBoundary: chunk.firstSample + chunk.sampleCount,
    };
    expect(chunk.geometry).toEqual(expectedSlice(centers, style, slice));
  }
  const finalizedSamples = preview.tail.firstSample + preview.tail.boundarySamples;
  expect(preview.tail.geometry).toEqual(
    expectedSlice(centers, style, {
      firstBoundary: finalizedSamples === 0 ? null : finalizedSamples - 1,
      lastBoundary: null,
    }),
  );
  if (preview.finalizedChunks.length === 0) {
    expect(preview.tail.geometry).toEqual(onePassPath(points, style));
  }
}

function expectedSlice(
  centers: ReturnType<typeof smoothStrokeCenters>,
  style: StrokeStyleV1,
  slice: { readonly firstBoundary: number | null; readonly lastBoundary: number | null },
) {
  return style.pressureEnabled
    ? buildPressureOutlineSlice(centers, style.width, slice)
    : buildCenterlineSlice(centers, slice);
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
    for (let index = 0; index < 4096; index += 1) {
      const preview = builder.append(sample(index));
      firstChunk ??= preview.finalizedChunks[0];
      if (firstChunk !== undefined) expect(preview.finalizedChunks[0]).toBe(firstChunk);
    }
    const commit = builder.finish();

    expect(commit.points).toHaveLength(4096 * 3);
    expect(commit.geometry).toEqual(onePassPath(commit.points, penStyle));
    expect(commit.instrumentation.maximumTailSamples).toBeLessThanOrEqual(16);
    expect(commit.instrumentation.maximumFinalizedChunkSamples).toBeLessThanOrEqual(16);
    expect(commit.instrumentation.retainedSamples).toBe(4096);
    expect(commit.instrumentation.bufferGrowths).toBe(8);
    expect(commit.instrumentation.tailBuilds).toBe(4096);
    expect(firstChunk).toBeDefined();
  });
});

describe("live stroke preview geometry", () => {
  it("uses finalized samples as read-only context while retaining the exact boundary segment", () => {
    const builder = new LiveStrokeBuilder({
      input: { pressureSource: "pen", zoom: 1 },
      style: { ...penStyle, pressureEnabled: false },
    });
    let preview = builder.append(sample(0));
    for (let index = 1; index < 20; index += 1) preview = builder.append(sample(index));

    expect(preview.tail.boundarySamples).toBe(4);
    expect(preview.tail.firstSample).toBe(8);
    expectExactPreview(
      preview,
      prepareStrokeSamples(
        Array.from({ length: 20 }, (_, index) => sample(index)),
        {
          pressureSource: "pen",
          zoom: 1,
        },
      ),
      { ...penStyle, pressureEnabled: false },
    );
    expect(preview.tail.geometry.d).toMatch(/^M11\.5(?:\D|$)/);
    expect(preview.tail.geometry.d).toContain("Q12 ");
  });

  it.each([
    ["pen-pressure", penStyle, "pen"],
    ["simulated-pressure", penStyle, "simulated"],
    ["centerline", { ...penStyle, opacity: 0.4, pressureEnabled: false }, "pen"],
  ] as const)("matches one-pass %s geometry across every chunk boundary", (_, style, source) => {
    const raw = Array.from({ length: 97 }, (_, index) => ({
      pressure: ((index * 37) % 101) / 100,
      time: index * 2 + (index % 3),
      x: index * 1.25,
      y: Math.sin(index / 3) * 20 + (index % 9 === 0 ? 12 : 0),
    }));
    const input = { pressureSource: source, zoom: 1 };
    const builder = new LiveStrokeBuilder({ input, style });
    for (let index = 0; index < raw.length; index += 1) {
      const preview = builder.append(raw[index]!);
      const points = prepareStrokeSamples(raw.slice(0, index + 1), input);
      expectExactPreview(preview, points, style);
    }
    const commit = builder.finish();
    expect(commit.geometry).toEqual(onePassPath(commit.points, style));
    expect(commit.instrumentation.finalizedChunkBuilds).toBeGreaterThan(1);
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
    expectExactPreview(preview, prepareStrokeSamples([...raw, replacement], input), penStyle);
  });

  it("keeps pressure caps at the real stroke ends and never creates a chunk-boundary cap", () => {
    const input = { pressureSource: "pen" as const, zoom: 1 };
    const builder = new LiveStrokeBuilder({ input, style: penStyle });
    let preview = builder.append(sample(0));
    for (let index = 1; index < 80; index += 1) preview = builder.append(sample(index));

    expect(preview.finalizedChunks).toHaveLength(8);
    expect(preview.finalizedChunks[0]!.geometry.d.match(/A/g)).toHaveLength(1);
    for (const chunk of preview.finalizedChunks.slice(1)) {
      expect(chunk.geometry.d).not.toContain("A");
    }
    expect(preview.tail.geometry.d.match(/A/g)).toHaveLength(1);
  });

  it("falls back to exact one-pass pressure geometry for repeated smoothed centers", () => {
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

describe("live stroke limits and lifecycle", () => {
  it("retains the final sample when input reaches the maximum", () => {
    const builder = new LiveStrokeBuilder({
      input: { pressureSource: "pen", zoom: 1 },
      style: penStyle,
    });

    let preview = builder.append(sample(0));
    for (let index = 1; index < 4096; index += 1) preview = builder.append(sample(index));
    const finalizedPrefix = preview.finalizedChunks.slice();
    preview = builder.append(sample(4096));

    const commit = builder.finish();

    expect(commit.points).toHaveLength(4096 * 3);
    expect(commit.points[commit.points.length - 3]).toBe(4096);
    expect(commit.instrumentation.appendedInputSamples).toBe(4097);
    expect(commit.instrumentation.retainedSamples).toBe(4096);
    expect(preview.finalizedChunks).toEqual(finalizedPrefix);
    expectExactPreview(preview, commit.points, penStyle);
  });

  it("replaces close mutable tips and enforces lifecycle and numeric limits", () => {
    const builder = new LiveStrokeBuilder({
      input: { pressureSource: "pen", zoom: 1 },
      style: penStyle,
    });
    builder.append({ x: 0, y: 0, pressure: 0.5, time: 0 });
    builder.append({ x: 1, y: 0, pressure: 0.5, time: 1 });
    builder.append({ x: 1.1, y: 0, pressure: 0.75, time: 2 });
    const commit = builder.finish();

    expect(commit.points).toEqual([0, 0, 0.5, 1.1, 0, 0.75]);
    expect(commit.instrumentation.replacedTipSamples).toBe(1);
    expect(() => builder.append(sample(3))).toThrow(/finished/);
    expect(() => builder.finish()).toThrow(/only be finished once/);
    expect(
      () => new LiveStrokeBuilder({ input: { pressureSource: "pen", zoom: 0 }, style: penStyle }),
    ).toThrow(RangeError);
  });
});
