import { denseWaveSamples } from "../../fixtures/editor/stroke";
import { MAX_STROKE_POINTS } from "../../../src/domain/schema/public";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as pressureWindows from "../../../src/domain/geometry/pressure/pressure-path-serialization";
import * as simplification from "../../../src/domain/geometry/stroke-simplification";
import * as strokeSlices from "../../../src/domain/geometry/pressure/pressure-outline";
import * as intersections from "../../../src/domain/geometry/pressure/pressure-boundary-intersections";
import { LiveStrokeBuilder, type LiveStrokeChunk } from "../../../src/editor/tools/live-stroke";
import { createMaximumStroke } from "./standard-domain-fixture";

afterEach(() => vi.restoreAllMocks());

describe("maximum live-stroke primitives", () => {
  it("bounds a maximum pressure stroke delivered one sample at a time", () => {
    const source = createMaximumStroke();
    const builder = new LiveStrokeBuilder({
      input: { pressureSource: "pen", zoom: 1 },
      style: source.style,
    });
    const pressureResponse = vi.spyOn(Math, "expm1");
    for (let point = 0; point < source.points.length; point += 3) {
      builder.append({
        pressure: source.points[point + 2]!,
        time: point / 3,
        x: source.points[point]!,
        y: source.points[point + 1]!,
      });
    }
    const commit = builder.finish();
    expect(pressureResponse).toHaveBeenCalledTimes(MAX_STROKE_POINTS - 1);
    expect(commit.instrumentation).toMatchObject({
      appendedInputSamples: MAX_STROKE_POINTS,
      commitBuilds: 1,
    });
    expect(commit.instrumentation.maximumTailSamples).toBeLessThanOrEqual(131);
    expect(commit.instrumentation.maximumFinalizedChunkSamples).toBeLessThanOrEqual(256);
    expect(commit.points).toHaveLength(MAX_STROKE_POINTS * 3);
    expect(commit.geometry.length).toBeGreaterThan(0);
    expect(commit.geometry.every(({ d }) => d.length > 0)).toBe(true);
  }, 120_000);

  it.each(["pen", "simulated"] as const)(
    "retains dense %s curves with bounded geometry and buffers",
    (pressureSource) => {
      const builder = new LiveStrokeBuilder({
        input: { pressureSource, zoom: 1 },
        style: createMaximumStroke().style,
      });
      const samples = denseWaveSamples();
      const pressureResponse = vi.spyOn(Math, "expm1");
      const outlines = vi.spyOn(strokeSlices, "visitPreparedPressureOutline");
      const simplify = vi.spyOn(simplification, "simplifyStrokeCenters");
      const prepareWindows = vi.spyOn(pressureWindows, "preparePressureWindows");
      const boundaryIntersections = vi.spyOn(intersections, "intersectPressureBoundaries");
      const batchSize = 9;
      let stableChunk: LiveStrokeChunk | undefined;
      for (let start = 0; start < samples.length; start += batchSize) {
        const preview = builder.appendBatch(samples.slice(start, start + batchSize));
        if (stableChunk !== undefined) expect(preview.finalizedChunks[0]).toBe(stableChunk);
        stableChunk ??= preview.finalizedChunks[0];
      }
      const outlineCalls = outlines.mock.calls.length;
      const simplifyCalls = simplify.mock.calls.length;
      const preparedWindowCalls = prepareWindows.mock.calls.length;
      const intersectionCalls = boundaryIntersections.mock.calls.length;
      const commit = builder.finish();
      expect(outlines).toHaveBeenCalledTimes(outlineCalls + 1);
      expect(outlines.mock.calls[outlineCalls]![0].length).toBeLessThanOrEqual(131);
      expect(simplify).toHaveBeenCalledTimes(simplifyCalls);
      expect(prepareWindows).toHaveBeenCalledTimes(preparedWindowCalls);
      expect(boundaryIntersections).toHaveBeenCalledTimes(intersectionCalls);
      const { retainedSamples, bufferGrowths, tailBuilds } = commit.instrumentation;
      expect(commit.instrumentation.maximumPendingPressurePieces).toBeLessThanOrEqual(64);

      expect(pressureResponse.mock.calls.length).toBeGreaterThanOrEqual(samples.length - 1);
      expect(pressureResponse.mock.calls.length).toBeLessThanOrEqual(2 * (samples.length - 1));
      expect(commit.instrumentation.sampleBufferBytes).toBe(80);
      expect(retainedSamples).toBeGreaterThan(300);
      expect(retainedSamples).toBeLessThan(samples.length);
      expect(bufferGrowths).toBe(0);
      expect(tailBuilds).toBe(samples.length / batchSize);
      // Each raw window prepares one cached capsule preview and one canonical piece batch.
      // Each input batch prepares only its incomplete preview tail; release classifies it once.
      expect(outlines.mock.calls.length).toBeLessThanOrEqual(
        tailBuilds + 2 * Math.ceil(retainedSamples / 64) + 1,
      );
      assertGeometryWork(
        builder.instrumentation().retainedSamples,
        outlines.mock.calls,
        prepareWindows.mock.calls,
      );
    },
  );
});

describe("maximum live-stroke capacity", () => {
  it.each(["pen", "simulated"] as const)(
    "bounds maximum %s strokes and freezes work after exhaustion",
    (pressureSource) => {
      const builder = new LiveStrokeBuilder({
        input: { pressureSource, zoom: 1 },
        style: createMaximumStroke().style,
      });
      const pressureResponse = vi.spyOn(Math, "expm1");
      const outlines = vi.spyOn(strokeSlices, "visitPreparedPressureOutline");
      const simplify = vi.spyOn(simplification, "simplifyStrokeCenters");
      const prepareWindows = vi.spyOn(pressureWindows, "preparePressureWindows");
      let stableChunk: LiveStrokeChunk | undefined;
      for (let start = 0; start < MAX_STROKE_POINTS; start += 256) {
        builder.appendBatch(
          Array.from({ length: 256 }, (_, offset) => ({
            x: start + offset,
            y: 20 * Math.sin((start + offset) / 10),
            pressure: 0.6,
            time: start + offset,
          })),
        );
        const preview = builder.preview();
        if (stableChunk !== undefined) expect(preview.finalizedChunks[0]).toBe(stableChunk);
        stableChunk ??= preview.finalizedChunks[0];
        expect(builder.instrumentation().sampleBufferBytes).toBe(80);
      }
      const retained = builder.preview();
      const before = builder.instrumentation();
      expect(before.sampleBufferBytes).toBe(80);
      expect(pressureResponse.mock.calls.length).toBeGreaterThanOrEqual(MAX_STROKE_POINTS - 1);
      expect(pressureResponse.mock.calls.length).toBeLessThanOrEqual(2 * (MAX_STROKE_POINTS - 1));
      expect(outlines.mock.calls.length).toBeLessThanOrEqual(
        before.tailBuilds + 2 * Math.ceil(MAX_STROKE_POINTS / 64),
      );
      assertGeometryWork(
        builder.instrumentation().retainedSamples,
        outlines.mock.calls,
        prepareWindows.mock.calls,
      );
      pressureResponse.mockClear();
      outlines.mockClear();
      for (let batch = 0; batch < 8; batch += 1) {
        builder.appendBatch(
          Array.from({ length: 512 }, (_, index) => ({
            x: MAX_STROKE_POINTS + batch * 512 + index,
            y: 20 * Math.sin(index / 10),
            pressure: index % 2,
            time: MAX_STROKE_POINTS + batch * 512 + index,
          })),
        );
      }
      expect(builder.capacityExhausted).toBe(true);
      expect(builder.preview().tail).toBe(retained.tail);
      expect(builder.preview().finalizedChunks).toBe(retained.finalizedChunks);
      expect(pressureResponse).not.toHaveBeenCalled();
      expect(outlines).not.toHaveBeenCalled();
      expect(builder.instrumentation()).toEqual({
        ...before,
        appendedInputSamples: MAX_STROKE_POINTS + 4096,
      });
      simplify.mockClear();
      prepareWindows.mockClear();
      expect(builder.finish().points).toHaveLength(MAX_STROKE_POINTS * 3);
      expect(outlines).toHaveBeenCalledOnce();
      expect(outlines.mock.calls[0]![0].length).toBeLessThanOrEqual(131);
      expect(simplify).not.toHaveBeenCalled();
      expect(prepareWindows).not.toHaveBeenCalled();
    },
  );
});

it("retains maximum highlighter geometry without unused pressure work or raw-prefix allocation", () => {
  const style = { ...createMaximumStroke().style, pressureEnabled: false };
  const builder = new LiveStrokeBuilder({
    input: { pressureSource: "simulated", zoom: 1 },
    style,
    tool: "highlighter",
  });
  const pressureResponse = vi.spyOn(Math, "expm1");
  const outlines = vi.spyOn(strokeSlices, "visitPreparedPressureOutline");
  for (let start = 0; start < MAX_STROKE_POINTS; start += 8) {
    builder.appendBatch(
      Array.from({ length: 8 }, (_, offset) => ({
        x: 100 + Math.abs((((start + offset) * 0.8) % 1600) - 800),
        y: 100,
        pressure: 0.5,
        time: start + offset,
      })),
    );
    expect(builder.instrumentation().sampleBufferBytes).toBe(80);
  }
  const accepted = builder.preview();
  builder.append({ x: 1000, y: 100, pressure: 0.5, time: MAX_STROKE_POINTS });
  expect(builder.capacityExhausted).toBe(true);
  expect(builder.preview().tail).toBe(accepted.tail);
  const commit = builder.finish();
  expect(commit.points).toHaveLength(MAX_STROKE_POINTS * 3);
  expect(commit.points.filter((_, index) => index % 3 === 2).every((value) => value === 0)).toBe(
    true,
  );
  expect(commit.instrumentation.bufferGrowths).toBe(0);
  expect(commit.geometry[0]!.paint).toBe("stroke");
  expect(pressureResponse).not.toHaveBeenCalled();
  expect(outlines).not.toHaveBeenCalled();
});

function assertGeometryWork(
  retainedSamples: number,
  outlines: readonly Parameters<typeof strokeSlices.visitPreparedPressureOutline>[],
  windows: readonly Parameters<typeof pressureWindows.preparePressureWindows>[],
): void {
  expect(windows.length).toBeLessThanOrEqual(Math.ceil(retainedSamples / 64));
  for (const [pieces] of windows) expect(pieces.length).toBeLessThanOrEqual(64);
  expect(outlines.length).toBeGreaterThan(0);
  for (const [centers] of outlines) expect(centers.length).toBeLessThanOrEqual(131);
}
