import { describe, expect, it } from "vitest";
import { runMaximumStrokes } from "./maximum-stroke-scenario";

describe("maximum live-stroke primitives", () => {
  it("keeps twenty maximum pressure strokes within tail and chunk bounds", () => {
    const result = runMaximumStrokes(20);
    expect(result.appendedSamples).toBe(20 * 4096);
    expect(result.completedStrokes).toBe(20);
    expect(result.maximumTailSamples).toBeLessThanOrEqual(16);
    expect(result.maximumFinalizedChunkSamples).toBeLessThanOrEqual(256);
  }, 120_000);
});
