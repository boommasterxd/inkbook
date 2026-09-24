import { denseWaveSamples } from "../../fixtures/editor/stroke";
import { MAX_STROKE_POINTS } from "../../../src/domain/schema/public";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as strokeSlices from "../../../src/domain/geometry/stroke-path-slice";
import { LiveStrokeBuilder, type LiveStrokeChunk } from "../../../src/editor/tools/live-stroke";
import { runMaximumStrokes } from "./maximum-stroke-scenario";
import { createMaximumStroke } from "./standard-domain-fixture";

afterEach(() => vi.restoreAllMocks());

describe("maximum live-stroke primitives", () => {
  it("keeps twenty maximum pressure strokes within tail and chunk bounds", () => {
    const pressureResponse = vi.spyOn(Math, "expm1");
    const result = runMaximumStrokes(20);
    expect(pressureResponse).toHaveBeenCalledTimes(20 * (MAX_STROKE_POINTS - 1));
    expect(result.appendedSamples).toBe(20 * MAX_STROKE_POINTS);
    expect(result.completedStrokes).toBe(20);
    expect(result.maximumTailSamples).toBeLessThanOrEqual(16);
    expect(result.maximumFinalizedChunkSamples).toBeLessThanOrEqual(256);
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
      const outlines = vi.spyOn(strokeSlices, "buildPressureOutlineSlice");
      const batchSize = 9;
      let stableChunk: LiveStrokeChunk | undefined;
      for (let start = 0; start < samples.length; start += batchSize) {
        const preview = builder.appendBatch(samples.slice(start, start + batchSize));
        if (stableChunk !== undefined) expect(preview.finalizedChunks[0]).toBe(stableChunk);
        stableChunk ??= preview.finalizedChunks[0];
      }
      const commit = builder.finish();
      const { retainedSamples, bufferGrowths, tailBuilds } = commit.instrumentation;

      expect(pressureResponse.mock.calls.length).toBeGreaterThanOrEqual(samples.length - 1);
      expect(pressureResponse.mock.calls.length).toBeLessThanOrEqual(2 * (samples.length - 1));
      expect(commit.instrumentation.sampleBufferBytes).toBeLessThanOrEqual(
        2 * retainedSamples * 5 * 8,
      );
      expect(retainedSamples).toBeGreaterThan(300);
      expect(retainedSamples).toBeLessThan(samples.length);
      expect(bufferGrowths).toBeLessThanOrEqual(Math.ceil(Math.log2(retainedSamples / 16)));
      expect(tailBuilds).toBe(samples.length / batchSize);
      // Each finalized chunk advances at least eight retained samples; each batch builds one tail.
      expect(outlines.mock.calls.length).toBeLessThanOrEqual(
        tailBuilds + Math.ceil(retainedSamples / 8),
      );
      for (const [centers] of outlines.mock.calls) expect(centers.length).toBeLessThanOrEqual(16);
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
      const outlines = vi.spyOn(strokeSlices, "buildPressureOutlineSlice");
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
        expect(builder.instrumentation().sampleBufferBytes).toBeLessThanOrEqual(
          MAX_STROKE_POINTS * 5 * 8,
        );
      }
      const retained = builder.preview();
      const before = builder.instrumentation();
      expect(before.sampleBufferBytes).toBe(MAX_STROKE_POINTS * 5 * 8);
      expect(pressureResponse.mock.calls.length).toBeGreaterThanOrEqual(MAX_STROKE_POINTS - 1);
      expect(pressureResponse.mock.calls.length).toBeLessThanOrEqual(2 * (MAX_STROKE_POINTS - 1));
      expect(outlines.mock.calls.length).toBeLessThanOrEqual(
        before.tailBuilds + Math.ceil(MAX_STROKE_POINTS / 8),
      );
      for (const [centers] of outlines.mock.calls) expect(centers.length).toBeLessThanOrEqual(16);
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
      expect(builder.finish().points).toHaveLength(MAX_STROKE_POINTS * 3);
    },
  );
});
