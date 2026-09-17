import { describe, expect, it } from "vitest";
import { measureMaximumStrokeRun } from "./maximum-stroke-scenario";
import { worstDistribution } from "./action-distribution";
import { measurementRuns } from "../sample-policy";
import { expectTiming } from "../timing-assertions";
import { INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";

describe("maximum live-stroke primitives", () => {
  it("updates and hands off twenty maximum pressure strokes per measured run", () => {
    measureMaximumStrokeRun(20);
    const measuredRuns = Array.from({ length: measurementRuns(5) }, () =>
      measureMaximumStrokeRun(20),
    );
    const releaseAppend = worstDistribution(measuredRuns.map(({ append }) => append));
    const releaseHandoff = worstDistribution(measuredRuns.map(({ handoff }) => handoff));

    expect(releaseAppend.sampleCount).toBe(20 * 4096);
    if (releaseAppend.p99 === null) throw new Error("Maximum-stroke append p99 is unavailable.");
    expectTiming(releaseAppend.p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    expect(releaseHandoff.sampleCount).toBe(20);
    expectTiming(releaseHandoff.maximum, INTERACTION_REFRESH_PROFILE.atomicCommitMaxMs);
    expect(measuredRuns.every(({ maximumTailSamples }) => maximumTailSamples <= 16)).toBe(true);
    expect(
      measuredRuns.every(({ maximumFinalizedChunkSamples }) =>
        Boolean(maximumFinalizedChunkSamples <= 256),
      ),
    ).toBe(true);
  }, 120_000);
});
