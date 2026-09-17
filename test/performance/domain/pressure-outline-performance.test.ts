import { describe, expect, it } from "vitest";

import { buildPressureOutline } from "../../../src/domain/geometry/pressure-outline";
import { LiveStrokeBuilder, type LiveStrokeChunk } from "../../../src/editor/tools/live-stroke";
import { interactionP99, INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";
import { measurePressureResizeFrame } from "./geometry-frame-fixture";
import { expectTiming } from "../timing-assertions";

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
  it("keeps maximum pressure transitions in a live tail within the frame budget", async ({
    annotate,
  }) => {
    const centers = Array.from({ length: 16 }, (_, index) => sample(index));
    const durations = new Array<number>(600);
    let maximumParts = 0;
    for (let run = 0; run < 600; run += 1) {
      const started = performance.now();
      const parts = buildPressureOutline(centers, 22);
      durations[run] = performance.now() - started;
      maximumParts = Math.max(maximumParts, parts.length);
    }
    const p99 = interactionP99(durations);
    expectTiming(p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    expect(maximumParts).toBe(1);
    await annotate(`Canonical 16-sample pressure geometry p99=${p99.toFixed(3)} ms`, "performance");
  });

  it("keeps 64 canonical resize curves within the frame budget at varying scales", async ({
    annotate,
  }) => {
    const source = Array.from({ length: 70 }, (_, index) => sample(index));
    const durations = new Array<number>(600);
    let minimumCommands = Infinity;
    for (let run = 0; run < 600; run += 1) {
      const { parts, duration } = measurePressureResizeFrame(source, run, buildPressureOutline);
      durations[run] = duration;
      minimumCommands = Math.min(minimumCommands, parts[0]!.d.match(/[Qq]/g)!.length);
      expect(parts).toHaveLength(1);
    }
    const p99 = interactionP99(durations);
    expectTiming(p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    expect(minimumCommands).toBeGreaterThanOrEqual(128);
    await annotate(`Canonical 64-curve resize geometry p99=${p99.toFixed(3)} ms`, "performance");
  });

  it("keeps 4096-point live writing bounded while preserving every pressure transition", async ({
    annotate,
  }) => {
    const builder = new LiveStrokeBuilder({
      input: { pressureSource: "pen", zoom: 1 },
      style: STYLE,
    });
    const durations = new Array<number>(512);
    let stableChunk: LiveStrokeChunk | undefined;
    for (let index = 0; index < 4096; index += 8) {
      const batch = Array.from({ length: 8 }, (_, offset) => sample(index + offset));
      const started = performance.now();
      const preview = builder.appendBatch(batch);
      durations[index / 8] = performance.now() - started;
      if (stableChunk !== undefined) expect(preview.finalizedChunks[0]).toBe(stableChunk);
      stableChunk ??= preview.finalizedChunks[0];
      expect(builder.instrumentation().commitBuilds).toBe(0);
    }
    const p99 = interactionP99(durations);
    const commit = builder.finish();
    expectTiming(p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
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
    await annotate(`Maximum-pressure live writing p99=${p99.toFixed(3)} ms`, "performance");
  });
});
