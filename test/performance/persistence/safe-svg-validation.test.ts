import { describe, expect, it } from "vitest";

import { yieldToMainThread } from "../../../src/persistence/scheduling/main-thread-yield";
import { inspectTrustedSvgOutput } from "../../../src/persistence/scheduling/trusted-svg-output";
import { createMaximumComplexitySvg } from "../../fixtures/persistence/safe-svg";
import { annotateDurations, expectProfileBudget, summarizeDurations } from "./metrics";

const MAIN_THREAD_BUDGET_MS = 8;

describe("safe SVG validation performance", () => {
  it("validates a maximum-size, maximum-command path in bounded main-thread slices", async ({
    annotate,
  }) => {
    const output = createMaximumComplexitySvg();
    await measureValidation(output);
    const runs = [];
    for (let run = 0; run < 5; run += 1) runs.push(await measureValidation(output));
    const maximumSlices = runs.map(({ maximumSliceMs }) => maximumSliceMs);

    await annotateDurations(
      annotate,
      "maximum-complexity safe SVG validation slices",
      maximumSlices,
    );
    expectProfileBudget(maximumSlices, MAIN_THREAD_BUDGET_MS);
    expect(runs.every(({ checkpoints }) => checkpoints > 70)).toBe(true);
    expect(
      runs.every(({ checkpoints, syntheticInputSamples }) => syntheticInputSamples === checkpoints),
    ).toBe(true);
  }, 120_000);
});

async function measureValidation(output: string): Promise<{
  readonly checkpoints: number;
  readonly maximumSliceMs: number;
  readonly syntheticInputSamples: number;
}> {
  const durations: number[] = [];
  let sliceStarted = performance.now();
  let checkpoints = 0;
  let syntheticInputSamples = 0;
  const trusted = await inspectTrustedSvgOutput(output, undefined, {
    checkpoint: async () => {
      durations.push(performance.now() - sliceStarted);
      checkpoints += 1;
      syntheticInputSamples += 1;
      await yieldToMainThread();
      sliceStarted = performance.now();
    },
    signal: new AbortController().signal,
  });
  durations.push(performance.now() - sliceStarted);
  expect(trusted.revision).toBe(3);
  return {
    checkpoints,
    maximumSliceMs: summarizeDurations(durations).maximum,
    syntheticInputSamples,
  };
}
