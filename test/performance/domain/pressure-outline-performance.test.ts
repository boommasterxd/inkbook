import { describe, expect, it } from "vitest";

import { buildPressureOutline } from "../../../src/domain/geometry/pressure-outline";
import { LiveStrokeBuilder, type LiveStrokeChunk } from "../../../src/editor/tools/live-stroke";
import { buildPressureResizeFrame } from "./geometry-frame-fixture";

const STYLE = {
  color: { type: "theme-text" as const },
  opacity: 1,
  pressureEnabled: true,
  smoothing: 0.5 as const,
  width: 22 as const,
};

function sample(index: number) {
  return { x: index % 2 ? 200 : 0, y: index, pressure: index % 2, time: index };
}

describe("bounded canonical pressure geometry", () => {
  it("keeps maximum pressure transitions in one bounded live-tail outline", () => {
    const centers = Array.from({ length: 16 }, (_, index) => sample(index));
    const parts = buildPressureOutline(centers, 22);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.d.length).toBeGreaterThan(0);
    expect(parts[0]!.d).not.toMatch(/NaN|Infinity/);
  });

  it("preserves 64 canonical resize curves at varying scales", () => {
    const source = Array.from({ length: 70 }, (_, index) => sample(index));
    for (const frame of [0, 136, 137, 172, 173, 599]) {
      const parts = buildPressureResizeFrame(source, frame, buildPressureOutline);
      expect(parts).toHaveLength(1);
      expect(parts[0]!.d.match(/[Qq]/g)!.length).toBeGreaterThanOrEqual(128);
      expect(parts[0]!.d).not.toMatch(/NaN|Infinity/);
    }
  });

  it("keeps 4096-point live writing bounded while preserving every pressure transition", () => {
    const builder = new LiveStrokeBuilder({
      input: { pressureSource: "pen", zoom: 1 },
      style: STYLE,
    });
    let stableChunk: LiveStrokeChunk | undefined;
    for (let index = 0; index < 4096; index += 8) {
      const batch = Array.from({ length: 8 }, (_, offset) => sample(index + offset));
      const preview = builder.appendBatch(batch);
      if (stableChunk !== undefined) expect(preview.finalizedChunks[0]).toBe(stableChunk);
      stableChunk ??= preview.finalizedChunks[0];
      expect(builder.instrumentation().commitBuilds).toBe(0);
    }
    const commit = builder.finish();
    expect(commit.points).toHaveLength(4096 * 3);
    expect(commit.geometry).toHaveLength(1);
    expect(commit.instrumentation.maximumTailSamples).toBeLessThanOrEqual(16);
    expect(commit.instrumentation.maximumFinalizedChunkSamples).toBeLessThanOrEqual(16);
    expect(commit.instrumentation).toMatchObject({
      appendedInputSamples: 4_096,
      retainedSamples: 4_096,
      replacedTipSamples: 0,
      commitBuilds: 1,
    });
    expect(commit.instrumentation.tailBuilds).toBe(512);
    expect(commit.instrumentation.bufferGrowths).toBeLessThanOrEqual(8);
    expect(commit.instrumentation.finalizedChunkBuilds).toBeLessThanOrEqual(512);
  });
});
